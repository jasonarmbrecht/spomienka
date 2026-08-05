//! PocketBase realtime subscription via SSE.
//!
//! PocketBase uses Server-Sent Events, not WebSocket:
//!   1. GET /api/realtime → SSE stream, first event gives clientId
//!   2. POST /api/realtime { clientId, subscriptions } → subscribe
//!   3. Read events from the open SSE stream

use crate::assets::Media;
use anyhow::{Context, Result};
use futures_util::StreamExt;
use reqwest::Client;
use serde::Deserialize;
use tokio::sync::mpsc;
use tokio::time::{sleep, Duration};

/// Events from the realtime subscription.
#[derive(Debug, Clone)]
pub enum RealtimeEvent {
    Connected,
    Disconnected,
    MediaCreated(Media),
    MediaUpdated(Media),
    MediaDeleted(String),
    RefreshNeeded,
    ConfigChanged,
    RepairRequested,
    RemoteNext,
    RemotePrev,
    RemoteRandom,
    RemotePause { secs: u64 },
    RemoteResume,
    RemoteTagFilter { tags: Vec<String>, mode: String },
    RemoteTagFilterClear,
}

#[derive(Debug, Default)]
struct SseEvent {
    event_type: String,
    data: String,
}

fn parse_sse_block(block: &str) -> SseEvent {
    let mut ev = SseEvent::default();
    for line in block.lines() {
        if let Some(v) = line.strip_prefix("event:") {
            ev.event_type = v.trim().to_string();
        } else if let Some(v) = line.strip_prefix("data:") {
            ev.data = v.trim().to_string();
        }
    }
    ev
}

#[derive(Debug, Deserialize)]
struct RealtimeMessage {
    #[serde(default)]
    action: Option<String>,
    #[serde(default)]
    record: Option<serde_json::Value>,
}

pub struct RealtimeManager {
    pb_url: String,
    event_tx: mpsc::Sender<RealtimeEvent>,
    device_id: Option<String>,
}

impl RealtimeManager {
    pub fn new(
        pb_url: String,
        device_id: Option<String>,
        event_tx: mpsc::Sender<RealtimeEvent>,
    ) -> Self {
        Self {
            pb_url,
            event_tx,
            device_id,
        }
    }

    fn build_subscriptions(&self) -> Vec<String> {
        let media_sub = if let Some(ref device_id) = self.device_id {
            format!(
                "media?filter=(status='published') && (deviceScopes~'\"{}\"' || deviceScopes = null || deviceScopes = '[]' || deviceScopes = '')",
                device_id
            )
        } else {
            "media?filter=status='published'".to_string()
        };
        let mut subs = vec![media_sub];
        if let Some(ref device_id) = self.device_id {
            // Subscribe to the inbox for this device — public read rule allows this
            // without admin auth. A "create" event here means config changed.
            subs.push(format!("device_inbox?filter=(device_id='{}')", device_id));
        }
        subs
    }

    pub async fn run(&self, token: Option<String>) {
        let client = Client::builder()
            .timeout(Duration::from_secs(60))
            .build()
            .unwrap_or_default();

        loop {
            tracing::info!("Connecting to PocketBase realtime...");

            match self.connect_and_subscribe(&client, token.as_deref()).await {
                Ok(()) => tracing::warn!("Realtime SSE stream closed, reconnecting in 5s..."),
                Err(e) => {
                    tracing::error!("Realtime connection error: {}, reconnecting in 5s...", e)
                }
            }

            let _ = self.event_tx.send(RealtimeEvent::Disconnected).await;
            sleep(Duration::from_secs(5)).await;
        }
    }

    async fn connect_and_subscribe(&self, client: &Client, token: Option<&str>) -> Result<()> {
        let url = format!("{}/api/realtime", self.pb_url);

        let mut req = client.get(&url).header("Accept", "text/event-stream");
        if let Some(t) = token {
            req = req.bearer_auth(t);
        }

        let response = req
            .send()
            .await
            .context("Failed to connect to SSE endpoint")?;
        if !response.status().is_success() {
            anyhow::bail!("SSE connection failed: {}", response.status());
        }

        let mut stream = response.bytes_stream();
        let mut buffer = String::new();
        let mut subscribed = false;

        while let Some(chunk) = stream.next().await {
            let chunk = chunk.context("SSE stream read error")?;
            buffer.push_str(&String::from_utf8_lossy(&chunk));

            // SSE events are separated by blank lines (\n\n)
            while let Some(pos) = buffer.find("\n\n") {
                let block = buffer[..pos].to_string();
                buffer = buffer[pos + 2..].to_string();

                if block.trim().is_empty() {
                    continue;
                }

                let ev = parse_sse_block(&block);

                if ev.event_type == "PB_CONNECT" {
                    let json: serde_json::Value = serde_json::from_str(&ev.data)
                        .context("Failed to parse PB_CONNECT payload")?;
                    let client_id = json
                        .get("clientId")
                        .and_then(|v| v.as_str())
                        .context("No clientId in PB_CONNECT")?
                        .to_string();

                    tracing::debug!("SSE clientId: {}", client_id);

                    // POST the subscription
                    let sub_url = format!("{}/api/realtime", self.pb_url);
                    let subscriptions = self.build_subscriptions();
                    let mut sub_req = client.post(&sub_url).json(&serde_json::json!({
                        "clientId": client_id,
                        "subscriptions": subscriptions,
                    }));
                    if let Some(t) = token {
                        sub_req = sub_req.bearer_auth(t);
                    }
                    let sub_res = sub_req
                        .send()
                        .await
                        .context("Failed to POST subscription")?;
                    if !sub_res.status().is_success() {
                        anyhow::bail!("Subscription POST failed: {}", sub_res.status());
                    }

                    subscribed = true;
                    let _ = self.event_tx.send(RealtimeEvent::Connected).await;
                    let _ = self.event_tx.send(RealtimeEvent::RefreshNeeded).await;
                    tracing::info!("Realtime connected and subscribed to: {:?}", subscriptions);
                } else if subscribed {
                    self.handle_sse_event(&ev).await;
                }
            }
        }

        Ok(())
    }

    fn parse_inbox_event(&self, data: &str) -> RealtimeEvent {
        let msg: serde_json::Value = serde_json::from_str(data).unwrap_or_default();
        let record = msg.get("record").cloned().unwrap_or_default();
        let cmd_type = record.get("type").and_then(|v| v.as_str()).unwrap_or("");
        let payload = record.get("payload").cloned().unwrap_or_default();

        match cmd_type {
            "next" => RealtimeEvent::RemoteNext,
            "prev" => RealtimeEvent::RemotePrev,
            "random" => RealtimeEvent::RemoteRandom,
            "pause" => RealtimeEvent::RemotePause {
                secs: payload
                    .get("secs")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(300)
                    .min(300),
            },
            "resume" => RealtimeEvent::RemoteResume,
            "tag-filter" => {
                let tags = payload
                    .get("tags")
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|v| v.as_str().map(|s| s.to_string()))
                            .collect()
                    })
                    .unwrap_or_default();
                let mode = payload
                    .get("mode")
                    .and_then(|v| v.as_str())
                    .unwrap_or("whitelist")
                    .to_string();
                RealtimeEvent::RemoteTagFilter { tags, mode }
            }
            "tag-filter-clear" => RealtimeEvent::RemoteTagFilterClear,
            "repair_request" => RealtimeEvent::RepairRequested,
            _ => RealtimeEvent::ConfigChanged,
        }
    }

    async fn handle_sse_event(&self, ev: &SseEvent) {
        if ev.data.is_empty() {
            return;
        }

        if ev.event_type.starts_with("device_inbox") {
            let event = self.parse_inbox_event(&ev.data);
            let _ = self.event_tx.send(event).await;
            return;
        }

        let msg: RealtimeMessage = match serde_json::from_str(&ev.data) {
            Ok(m) => m,
            Err(e) => {
                tracing::debug!("Failed to parse SSE data: {} — {}", e, ev.data);
                return;
            }
        };

        let Some(action) = msg.action else { return };

        let event = match action.as_str() {
            "create" => msg
                .record
                .and_then(|r| match serde_json::from_value::<Media>(r) {
                    Ok(m) if self.matches_filter(&m) => Some(RealtimeEvent::MediaCreated(m)),
                    Ok(_) => None,
                    Err(e) => {
                        tracing::warn!("Failed to parse created media: {}", e);
                        None
                    }
                }),
            "update" => msg
                .record
                .and_then(|r| match serde_json::from_value::<Media>(r) {
                    Ok(m) => Some(if self.matches_filter(&m) {
                        RealtimeEvent::MediaUpdated(m)
                    } else {
                        RealtimeEvent::MediaDeleted(m.id)
                    }),
                    Err(e) => {
                        tracing::warn!("Failed to parse updated media: {}", e);
                        None
                    }
                }),
            "delete" => msg.record.and_then(|r| {
                r.get("id")
                    .and_then(|v| v.as_str())
                    .map(|id| RealtimeEvent::MediaDeleted(id.to_string()))
            }),
            _ => None,
        };

        if let Some(event) = event {
            tracing::debug!("Realtime event: {:?}", event);
            let _ = self.event_tx.send(event).await;
        }
    }

    fn matches_filter(&self, media: &Media) -> bool {
        if let Some(ref device_id) = self.device_id {
            if let Some(ref scopes) = media.device_scopes {
                if let Some(arr) = scopes.as_array() {
                    if !arr.is_empty() {
                        return arr.iter().any(|v| v.as_str() == Some(device_id));
                    }
                }
            }
        }
        true
    }
}

pub fn spawn_realtime(
    pb_url: String,
    device_id: Option<String>,
    token: Option<String>,
) -> mpsc::Receiver<RealtimeEvent> {
    let (tx, rx) = mpsc::channel(100);
    let manager = RealtimeManager::new(pb_url, device_id, tx);
    tokio::spawn(async move {
        manager.run(token).await;
    });
    rx
}

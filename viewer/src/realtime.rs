//! PocketBase realtime subscription module.
//!
//! Connects to PocketBase WebSocket API for live playlist updates.

use crate::assets::Media;
use anyhow::{Context, Result};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::{mpsc, RwLock};
use tokio::time::{sleep, Duration};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{client::IntoClientRequest, Message},
};
use url::Url;

/// Events from the realtime subscription.
#[derive(Debug, Clone)]
pub enum RealtimeEvent {
    /// Connection established.
    Connected,
    /// Connection lost.
    Disconnected,
    /// Media item created.
    MediaCreated(Media),
    /// Media item updated.
    MediaUpdated(Media),
    /// Media item deleted.
    MediaDeleted(String),
    /// Full playlist refresh needed.
    RefreshNeeded,
}

/// PocketBase realtime message types.
#[derive(Debug, Deserialize)]
struct RealtimeMessage {
    #[serde(default)]
    event: Option<String>,
    #[serde(default)]
    action: Option<String>,
    #[serde(default)]
    record: Option<serde_json::Value>,
}

/// Subscribe request for PocketBase.
#[derive(Debug, Serialize)]
struct SubscribeRequest {
    #[serde(rename = "clientId")]
    client_id: String,
    subscriptions: Vec<String>,
}

/// Realtime connection manager.
pub struct RealtimeManager {
    pb_url: String,
    event_tx: mpsc::Sender<RealtimeEvent>,
    is_connected: Arc<RwLock<bool>>,
    device_id: Option<String>,
}

impl RealtimeManager {
    /// Create a new realtime manager.
    pub fn new(
        pb_url: String,
        device_id: Option<String>,
        event_tx: mpsc::Sender<RealtimeEvent>,
    ) -> Self {
        Self {
            pb_url,
            event_tx,
            is_connected: Arc::new(RwLock::new(false)),
            device_id,
        }
    }

    /// Build the WebSocket URL.
    fn ws_url(&self) -> Result<Url> {
        let mut url = Url::parse(&self.pb_url).context("Invalid PocketBase URL")?;

        // Change scheme to ws/wss
        let scheme = if url.scheme() == "https" {
            "wss"
        } else {
            "ws"
        };
        url.set_scheme(scheme)
            .map_err(|_| anyhow::anyhow!("Failed to set WebSocket scheme"))?;

        url.set_path("/api/realtime");

        Ok(url)
    }

    /// Build the subscription filter for media collection.
    fn build_subscription(&self) -> String {
        let base_filter = "status='published'";

        if let Some(ref device_id) = self.device_id {
            // Filter by device scope
            format!(
                "media?filter=({}) && (deviceScopes~'{}' || deviceScopes='[]' || deviceScopes='' || deviceScopes=null)",
                base_filter, device_id
            )
        } else {
            format!("media?filter={}", base_filter)
        }
    }

    /// Start the realtime connection loop.
    pub async fn run(&self, token: Option<String>) {
        loop {
            tracing::info!("Connecting to PocketBase realtime...");

            match self.connect_and_subscribe(token.as_deref()).await {
                Ok(()) => {
                    tracing::warn!("Realtime connection closed, reconnecting in 5s...");
                }
                Err(e) => {
                    tracing::error!("Realtime connection error: {}, reconnecting in 5s...", e);
                }
            }

            // Mark as disconnected
            *self.is_connected.write().await = false;
            let _ = self.event_tx.send(RealtimeEvent::Disconnected).await;

            // Wait before reconnecting
            sleep(Duration::from_secs(5)).await;
        }
    }

    /// Connect and subscribe to the media collection.
    async fn connect_and_subscribe(&self, token: Option<&str>) -> Result<()> {
        let url = self.ws_url()?;
        tracing::debug!("Connecting to: {}", url);

        // Build request with auth header if token provided
        let mut request = url.to_string().into_client_request()?;
        if let Some(token) = token {
            request.headers_mut().insert(
                "Authorization",
                format!("Bearer {}", token).parse().unwrap(),
            );
        }

        let (ws_stream, _response) = connect_async(request)
            .await
            .context("Failed to connect to WebSocket")?;

        let (mut write, mut read) = ws_stream.split();

        // Wait for the initial client ID message
        let client_id = loop {
            if let Some(msg) = read.next().await {
                let msg = msg.context("Failed to receive message")?;
                if let Message::Text(text) = msg {
                    if let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) {
                        if let Some(id) = json.get("clientId").and_then(|v| v.as_str()) {
                            break id.to_string();
                        }
                    }
                }
            }
        };

        tracing::debug!("Got client ID: {}", client_id);

        // Subscribe to media collection
        let subscription = self.build_subscription();
        let subscribe_msg = serde_json::json!({
            "clientId": client_id,
            "subscriptions": [subscription]
        });

        write
            .send(Message::Text(subscribe_msg.to_string()))
            .await
            .context("Failed to send subscription")?;

        // Mark as connected
        *self.is_connected.write().await = true;
        let _ = self.event_tx.send(RealtimeEvent::Connected).await;
        let _ = self.event_tx.send(RealtimeEvent::RefreshNeeded).await;

        tracing::info!("Realtime connected and subscribed");

        // Process messages
        while let Some(msg) = read.next().await {
            let msg = msg.context("Failed to receive message")?;

            match msg {
                Message::Text(text) => {
                    self.handle_message(&text).await;
                }
                Message::Ping(data) => {
                    write
                        .send(Message::Pong(data))
                        .await
                        .context("Failed to send pong")?;
                }
                Message::Close(_) => {
                    tracing::info!("WebSocket closed by server");
                    break;
                }
                _ => {}
            }
        }

        Ok(())
    }

    /// Handle an incoming realtime message.
    async fn handle_message(&self, text: &str) {
        let msg: RealtimeMessage = match serde_json::from_str(text) {
            Ok(m) => m,
            Err(e) => {
                tracing::debug!("Failed to parse realtime message: {} - {}", e, text);
                return;
            }
        };

        // Skip non-record messages
        let Some(action) = msg.action else {
            return;
        };

        let event = match action.as_str() {
            "create" => {
                if let Some(record) = msg.record {
                    match serde_json::from_value::<Media>(record) {
                        Ok(media) => {
                            // Only process published media
                            if self.matches_filter(&media) {
                                Some(RealtimeEvent::MediaCreated(media))
                            } else {
                                None
                            }
                        }
                        Err(e) => {
                            tracing::warn!("Failed to parse media record: {}", e);
                            None
                        }
                    }
                } else {
                    None
                }
            }
            "update" => {
                if let Some(record) = msg.record {
                    match serde_json::from_value::<Media>(record) {
                        Ok(media) => {
                            if self.matches_filter(&media) {
                                Some(RealtimeEvent::MediaUpdated(media))
                            } else {
                                // Media no longer matches filter (e.g., unpublished)
                                Some(RealtimeEvent::MediaDeleted(media.id))
                            }
                        }
                        Err(e) => {
                            tracing::warn!("Failed to parse media record: {}", e);
                            None
                        }
                    }
                } else {
                    None
                }
            }
            "delete" => {
                if let Some(record) = msg.record {
                    if let Some(id) = record.get("id").and_then(|v| v.as_str()) {
                        Some(RealtimeEvent::MediaDeleted(id.to_string()))
                    } else {
                        None
                    }
                } else {
                    None
                }
            }
            _ => None,
        };

        if let Some(event) = event {
            tracing::debug!("Realtime event: {:?}", event);
            let _ = self.event_tx.send(event).await;
        }
    }

    /// Check if a media item matches our filter.
    fn matches_filter(&self, media: &Media) -> bool {
        // Check device scope if we have a device ID
        if let Some(ref device_id) = self.device_id {
            if let Some(ref scopes) = media.device_scopes {
                // If scopes is an array, check if our device is in it or if it's empty
                if let Some(arr) = scopes.as_array() {
                    if !arr.is_empty() {
                        let has_device = arr.iter().any(|v| {
                            v.as_str().map(|s| s == device_id).unwrap_or(false)
                        });
                        if !has_device {
                            return false;
                        }
                    }
                }
            }
        }

        true
    }

    /// Check if currently connected.
    pub async fn is_connected(&self) -> bool {
        *self.is_connected.read().await
    }
}

/// Spawn the realtime manager as a background task.
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


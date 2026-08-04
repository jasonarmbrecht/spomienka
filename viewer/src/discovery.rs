//! Discovery mode for unregistered viewers.
//!
//! When no device_id is configured, the viewer enters discovery mode:
//!   1. Generates a session ID and 6-digit PIN
//!   2. Announces itself to the backend every 15 seconds
//!   3. Polls the backend for registration confirmation every 5 seconds
//!   4. On claim: writes device_id + api_key to config.toml and exits

use anyhow::Result;
use rand::Rng;
use reqwest::Client;
use serde::Deserialize;
use sha2::{Digest, Sha256};

#[derive(Debug, Clone)]
pub struct DiscoveryState {
    pub session_id: String,
    pub pin: String,
    pub pin_hash: String,
    pub local_ip: String,
    pub hostname: String,
    /// Set when re-pairing an already-known device that lost its api_key
    /// (see repair discovery mode in main.rs). Tells the backend to update
    /// this existing device record instead of creating a new one.
    pub repair_device_id: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ClaimResult {
    pub device_id: String,
    pub api_key: String,
}

impl DiscoveryState {
    /// When `repair_device_id` is set, the resulting announce/register cycle
    /// updates that existing device's api_key in place instead of creating a
    /// brand-new device record.
    pub fn new_with_repair(repair_device_id: Option<String>) -> Result<Self> {
        let session_id = generate_session_id();
        let pin = generate_pin();
        let pin_hash = compute_pin_hash(&session_id, &pin);
        let local_ip = detect_local_ip().unwrap_or_else(|_| "unknown".to_string());
        let hostname = read_hostname();
        Ok(Self {
            session_id,
            pin,
            pin_hash,
            local_ip,
            hostname,
            repair_device_id,
        })
    }
}

fn generate_session_id() -> String {
    let bytes: [u8; 16] = rand::thread_rng().gen();
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

fn generate_pin() -> String {
    let pin: u32 = rand::thread_rng().gen_range(0..1_000_000);
    format!("{:06}", pin)
}

fn compute_pin_hash(session_id: &str, pin: &str) -> String {
    let input = format!("{}{}", session_id, pin);
    let result = Sha256::digest(input.as_bytes());
    format!("{:x}", result)
}

fn detect_local_ip() -> Result<String> {
    let socket = std::net::UdpSocket::bind("0.0.0.0:0")?;
    socket.connect("8.8.8.8:53")?;
    Ok(socket.local_addr()?.ip().to_string())
}

fn read_hostname() -> String {
    std::fs::read_to_string("/etc/hostname")
        .unwrap_or_else(|_| std::env::var("HOSTNAME").unwrap_or_else(|_| "viewer".to_string()))
        .trim()
        .to_string()
}

pub async fn announce(client: &Client, pb_url: &str, state: &DiscoveryState) -> Result<()> {
    let url = format!("{}/api/spomienka/announce", pb_url);
    let res = client
        .post(&url)
        .json(&serde_json::json!({
            "session_id": state.session_id,
            "pin_hash": state.pin_hash,
            "hostname": state.hostname,
            "ip": state.local_ip,
            "repair_device_id": state.repair_device_id,
        }))
        .send()
        .await?;

    if !res.status().is_success() {
        let status = res.status();
        let body = res.text().await.unwrap_or_default();
        anyhow::bail!("announce {} — {}", status, body);
    }
    Ok(())
}

pub async fn poll_claim(
    client: &Client,
    pb_url: &str,
    session_id: &str,
) -> Result<Option<ClaimResult>> {
    let url = format!("{}/api/spomienka/claim?sid={}", pb_url, session_id);
    let res = client.get(&url).send().await?;

    if !res.status().is_success() {
        return Ok(None);
    }

    let body: serde_json::Value = res.json().await?;

    if body.get("status").and_then(|s| s.as_str()) == Some("waiting") {
        return Ok(None);
    }

    if let (Some(device_id), Some(api_key)) = (
        body.get("device_id").and_then(|v| v.as_str()),
        body.get("api_key").and_then(|v| v.as_str()),
    ) {
        return Ok(Some(ClaimResult {
            device_id: device_id.to_string(),
            api_key: api_key.to_string(),
        }));
    }

    Ok(None)
}

/// Write device_id and device_api_key into the viewer's config file.
///
/// Tries /etc/frame-viewer/config.toml first (production), then ./config.toml (dev).
/// Existing device_id/device_api_key lines are replaced; all other settings preserved.
pub fn write_device_credentials(device_id: &str, api_key: &str) -> Result<()> {
    let config_path = if std::path::Path::new("/etc/frame-viewer/config.toml").exists() {
        "/etc/frame-viewer/config.toml"
    } else {
        "config.toml"
    };

    let existing = std::fs::read_to_string(config_path).unwrap_or_default();

    let filtered: String = existing
        .lines()
        .filter(|l| {
            let t = l.trim_start();
            !t.starts_with("device_id") && !t.starts_with("device_api_key")
        })
        .collect::<Vec<_>>()
        .join("\n");

    let mut new_content = filtered;
    if !new_content.is_empty() && !new_content.ends_with('\n') {
        new_content.push('\n');
    }
    new_content.push_str(&format!("device_id = \"{}\"\n", device_id));
    new_content.push_str(&format!("device_api_key = \"{}\"\n", api_key));

    std::fs::write(config_path, new_content)?;
    tracing::info!("Wrote device credentials to {}", config_path);
    Ok(())
}

/// Remove the device_api_key line from the viewer's config file, leaving
/// device_id untouched. Used when a repair is requested: on the next start
/// the viewer finds device_id present but no api_key and re-enters discovery
/// mode to get a fresh key for that same device (see `run_discovery_mode`'s
/// repair branch in main.rs).
pub fn clear_device_api_key() -> Result<()> {
    let config_path = if std::path::Path::new("/etc/frame-viewer/config.toml").exists() {
        "/etc/frame-viewer/config.toml"
    } else {
        "config.toml"
    };

    let existing = std::fs::read_to_string(config_path).unwrap_or_default();

    let filtered: String = existing
        .lines()
        .filter(|l| !l.trim_start().starts_with("device_api_key"))
        .collect::<Vec<_>>()
        .join("\n");

    let mut new_content = filtered;
    if !new_content.is_empty() && !new_content.ends_with('\n') {
        new_content.push('\n');
    }

    std::fs::write(config_path, new_content)?;
    tracing::info!("Cleared device_api_key in {} for repair", config_path);
    Ok(())
}

use anyhow::Result;
use config::{Config, Environment, File};
use reqwest::{Client, StatusCode};
use serde::Deserialize;
use tokio::time::{sleep, Duration};

/// Application configuration loaded from TOML file with environment variable overrides.
#[derive(Debug, Deserialize)]
struct AppConfig {
    /// PocketBase API URL (env: POCKETBASE_URL or config: pb_url)
    #[serde(default = "default_pb_url")]
    pb_url: String,
    /// Refresh/slide interval in milliseconds
    #[serde(default = "default_interval_ms")]
    interval_ms: u64,
    /// Transition type: fade, crossfade, cut
    #[serde(default = "default_transition")]
    transition: String,
    /// Local cache directory for downloaded assets
    #[serde(default = "default_cache_dir")]
    cache_dir: String,
    /// Optional device ID for device-specific playlisting
    #[serde(default)]
    device_id: Option<String>,
    /// Optional device API key for authentication
    #[serde(default)]
    device_api_key: Option<String>,
    /// Auth email for PocketBase (alternative to token)
    #[serde(default)]
    auth_email: Option<String>,
    /// Auth password for PocketBase (alternative to token)
    #[serde(default)]
    auth_password: Option<String>,
    /// Direct auth token for PocketBase
    #[serde(default)]
    auth_token: Option<String>,
}

fn default_pb_url() -> String {
    "http://localhost:8090".to_string()
}

fn default_interval_ms() -> u64 {
    8000
}

fn default_transition() -> String {
    "fade".to_string()
}

fn default_cache_dir() -> String {
    "/var/cache/frame-viewer".to_string()
}

impl AppConfig {
    /// Load configuration from file and environment variables.
    /// Priority: environment variables > config file > defaults
    fn load() -> Result<Self> {
        let config = Config::builder()
            // Start with defaults
            .set_default("pb_url", default_pb_url())?
            .set_default("interval_ms", default_interval_ms() as i64)?
            .set_default("transition", default_transition())?
            .set_default("cache_dir", default_cache_dir())?
            // Load from config file (optional, won't fail if missing)
            .add_source(File::with_name("/etc/frame-viewer/config").required(false))
            // Also check local config for development
            .add_source(File::with_name("config").required(false))
            // Environment variables override everything
            // POCKETBASE_URL -> pb_url, INTERVAL_MS -> interval_ms, etc.
            .add_source(
                Environment::default()
                    .prefix("POCKETBASE")
                    .prefix_separator("_")
                    .try_parsing(true)
                    .separator("_")
            )
            // Also support non-prefixed env vars for backwards compatibility
            .add_source(
                Environment::default()
                    .try_parsing(true)
            )
            .build()?;

        Ok(config.try_deserialize()?)
    }

    fn to_auth_creds(&self) -> AuthCreds {
        AuthCreds {
            token: self.auth_token.clone().filter(|s| !s.is_empty()),
            email: self.auth_email.clone().filter(|s| !s.is_empty()),
            password: self.auth_password.clone().filter(|s| !s.is_empty()),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)] // Fields are parsed but not all are used yet.
struct Media {
    id: String,
    r#type: String,
    display_url: Option<String>,
    blur_url: Option<String>,
    video_url: Option<String>,
    poster_url: Option<String>,
    duration: Option<f32>,
}

#[derive(Debug, Deserialize)]
struct ListResponse<T> {
    items: Vec<T>,
}

#[tokio::main]
async fn main() -> Result<()> {
    // Load configuration from file and environment
    let config = AppConfig::load()?;
    
    println!("Starting frame-viewer with config:");
    println!("  PocketBase URL: {}", config.pb_url);
    println!("  Interval: {}ms", config.interval_ms);
    println!("  Transition: {}", config.transition);
    println!("  Cache dir: {}", config.cache_dir);
    if let Some(ref device_id) = config.device_id {
        println!("  Device ID: {}", device_id);
    }

    let client = Client::new();
    let creds = config.to_auth_creds();
    let mut auth_token = initial_auth_token(&client, &config.pb_url, &creds).await?;

    loop {
        match fetch_playlist(&client, &config.pb_url, &mut auth_token, &creds).await {
            Ok(media) => println!("Fetched {} published items", media.len()),
            Err(err) => eprintln!("Failed to fetch playlist: {err:?}"),
        }

        sleep(Duration::from_millis(config.interval_ms)).await;
    }
    // TODO: initialize renderer (SDL2/wgpu) and video playback (gstreamer/ffmpeg).
    // TODO: preload next asset, render blurred background + main image/video, apply fade transitions.
    // TODO: cache assets on disk and run realtime subscription for updates.
}

async fn fetch_playlist(
    client: &Client,
    api: &str,
    token: &mut Option<String>,
    creds: &AuthCreds,
) -> Result<Vec<Media>> {
    let url = format!("{}/api/collections/media/records?filter=status='published'&perPage=200", api);
    let (status, res) = send_request(client, &url, token.as_deref()).await?;
    if status != StatusCode::UNAUTHORIZED {
        return parse_list(res).await;
    }

    // 401: try to refresh token if we have credentials.
    if let Some(new_token) = refresh_token(client, api, creds).await? {
        *token = Some(new_token.clone());
        let (_, res) = send_request(client, &url, Some(&new_token)).await?;
        return parse_list(res).await;
    }

    Err(anyhow::anyhow!(
        "Unauthorized fetching playlist and no credentials to refresh"
    ))
}

async fn send_request(
    client: &Client,
    url: &str,
    token: Option<&str>,
) -> Result<(StatusCode, reqwest::Response)> {
    let mut req = client.get(url);
    if let Some(token) = token {
        req = req.bearer_auth(token);
    }
    let res = req.send().await?;
    let status = res.status();
    if status == StatusCode::UNAUTHORIZED {
        return Ok((status, res));
    }
    let res = res.error_for_status()?;
    Ok((status, res))
}

async fn parse_list(res: reqwest::Response) -> Result<Vec<Media>> {
    let parsed: ListResponse<Media> = res.json().await?;
    Ok(parsed.items)
}

#[derive(Debug, Clone)]
struct AuthCreds {
    email: Option<String>,
    password: Option<String>,
    token: Option<String>,
}

impl AuthCreds {
    fn can_login(&self) -> bool {
        self.email.is_some() && self.password.is_some()
    }
}

async fn initial_auth_token(client: &Client, api: &str, creds: &AuthCreds) -> Result<Option<String>> {
    if let Some(token) = creds.token.clone() {
        return Ok(Some(token));
    }
    if creds.can_login() {
        if let Some(new_token) = refresh_token(client, api, creds).await? {
            return Ok(Some(new_token));
        }
    }
    Ok(None)
}

async fn refresh_token(client: &Client, api: &str, creds: &AuthCreds) -> Result<Option<String>> {
    if !creds.can_login() {
        return Ok(None);
    }

    let url = format!("{}/api/collections/users/auth-with-password", api);
    #[derive(Deserialize)]
    struct AuthResponse {
        token: String,
    }

    let res = client
        .post(url)
        .json(&serde_json::json!({
            "identity": creds.email.as_ref().unwrap(),
            "password": creds.password.as_ref().unwrap(),
        }))
        .send()
        .await?
        .error_for_status()?;

    let parsed: AuthResponse = res.json().await?;
    Ok(Some(parsed.token))
}

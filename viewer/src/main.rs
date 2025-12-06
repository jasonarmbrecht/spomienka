use anyhow::Result;
use reqwest::Client;
use serde::Deserialize;
use tokio::time::{sleep, Duration};

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
    let api = std::env::var("POCKETBASE_URL").unwrap_or_else(|_| "http://localhost:8090".into());
    // Allow slow polling so the systemd service does not exit immediately.
    let refresh_ms: u64 = std::env::var("REFRESH_MS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(30_000);
    let client = Client::new();

    // Optional auth: POCKETBASE_TOKEN, or POCKETBASE_AUTH_EMAIL + POCKETBASE_AUTH_PASSWORD.
    let auth_token = get_auth_token(&client, &api).await?;

    loop {
        match fetch_playlist(&client, &api, auth_token.as_deref()).await {
            Ok(media) => println!("Fetched {} published items", media.len()),
            Err(err) => eprintln!("Failed to fetch playlist: {err:?}"),
        }

        sleep(Duration::from_millis(refresh_ms)).await;
    }
    // TODO: initialize renderer (SDL2/wgpu) and video playback (gstreamer/ffmpeg).
    // TODO: preload next asset, render blurred background + main image/video, apply fade transitions.
    // TODO: cache assets on disk and run realtime subscription for updates.
}

async fn fetch_playlist(client: &Client, api: &str, token: Option<&str>) -> Result<Vec<Media>> {
    let url = format!("{}/api/collections/media/records?filter=status='published'&perPage=200", api);
    let mut req = client.get(url);
    if let Some(token) = token {
        req = req.bearer_auth(token);
    }

    let res = req.send().await?.error_for_status()?;
    let parsed: ListResponse<Media> = res.json().await?;
    Ok(parsed.items)
}

async fn get_auth_token(client: &Client, api: &str) -> Result<Option<String>> {
    // Prefer explicit token.
    if let Ok(token) = std::env::var("POCKETBASE_TOKEN") {
        if !token.is_empty() {
            return Ok(Some(token));
        }
    }

    // Fallback: login with email/password if provided.
    let email = std::env::var("POCKETBASE_AUTH_EMAIL").ok();
    let password = std::env::var("POCKETBASE_AUTH_PASSWORD").ok();
    if let (Some(email), Some(password)) = (email, password) {
        let url = format!("{}/api/collections/users/auth-with-password", api);
        #[derive(Deserialize)]
        struct AuthResponse {
            token: String,
        }

        let res = client
            .post(url)
            .json(&serde_json::json!({ "identity": email, "password": password }))
            .send()
            .await?
            .error_for_status()?;

        let parsed: AuthResponse = res.json().await?;
        return Ok(Some(parsed.token));
    }

    Ok(None)
}


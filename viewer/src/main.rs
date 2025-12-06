use anyhow::Result;
use reqwest::Client;
use serde::Deserialize;

#[derive(Debug, Deserialize)]
struct Media {
    id: String,
    r#type: String,
    displayUrl: Option<String>,
    blurUrl: Option<String>,
    videoUrl: Option<String>,
    posterUrl: Option<String>,
    duration: Option<f32>,
}

#[derive(Debug, Deserialize)]
struct ListResponse<T> {
    items: Vec<T>,
}

#[tokio::main]
async fn main() -> Result<()> {
    let api = std::env::var("POCKETBASE_URL").unwrap_or_else(|_| "http://localhost:8090".into());
    let client = Client::new();

    let media = fetch_playlist(&client, &api).await?;
    println!("Fetched {} published items", media.len());

    // TODO: initialize renderer (SDL2/wgpu) and video playback (gstreamer/ffmpeg).
    // TODO: preload next asset, render blurred background + main image/video, apply fade transitions.
    // TODO: cache assets on disk and run realtime subscription for updates.

    Ok(())
}

async fn fetch_playlist(client: &Client, api: &str) -> Result<Vec<Media>> {
    let url = format!("{}/api/collections/media/records?filter=status='published'&perPage=200", api);
    let res = client.get(url).send().await?.error_for_status()?;
    let parsed: ListResponse<Media> = res.json().await?;
    Ok(parsed.items)
}


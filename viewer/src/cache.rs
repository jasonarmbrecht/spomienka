//! LRU cache module for offline asset storage.
//!
//! Manages downloading, storing, and evicting cached media assets.

use crate::assets::{AssetType, Media};
use anyhow::{Context, Result};
use lru::LruCache;
use std::collections::HashMap;
use std::fs;
use std::num::NonZeroUsize;
use std::path::PathBuf;
use tokio::io::AsyncWriteExt;
use walkdir::WalkDir;

/// Metadata for a cached asset.
#[derive(Debug, Clone)]
struct CacheEntry {
    path: PathBuf,
    size: u64,
}

/// LRU cache for media assets.
pub struct Cache {
    /// Base directory for cached files.
    cache_dir: PathBuf,
    /// Maximum cache size in bytes.
    max_size: u64,
    /// Current cache size in bytes.
    current_size: u64,
    /// LRU tracking for cache entries (key: media_id:asset_type).
    lru: LruCache<String, CacheEntry>,
    /// Quick lookup by media ID and asset type.
    index: HashMap<String, PathBuf>,
}

impl Cache {
    /// Create a new cache with the given directory and size limit.
    pub fn new(cache_dir: PathBuf, max_size_gb: u64) -> Result<Self> {
        let max_size = max_size_gb * 1024 * 1024 * 1024;

        // Create cache directory if it doesn't exist
        fs::create_dir_all(&cache_dir).context("Failed to create cache directory")?;

        let mut cache = Self {
            cache_dir,
            max_size,
            current_size: 0,
            lru: LruCache::new(NonZeroUsize::new(10000).unwrap()),
            index: HashMap::new(),
        };

        // Scan existing cache directory
        cache.scan_existing()?;

        tracing::info!(
            "Cache initialized: {:.2} GB / {:.2} GB used",
            cache.current_size as f64 / 1024.0 / 1024.0 / 1024.0,
            max_size_gb as f64
        );

        Ok(cache)
    }

    /// Scan existing cache directory and populate the index.
    fn scan_existing(&mut self) -> Result<()> {
        for entry in WalkDir::new(&self.cache_dir)
            .min_depth(2)
            .max_depth(2)
            .into_iter()
            .filter_map(|e| e.ok())
        {
            if entry.file_type().is_file() {
                let path = entry.path().to_path_buf();
                if let Ok(metadata) = fs::metadata(&path) {
                    let size = metadata.len();

                    // Extract media_id from parent directory name
                    if let Some(parent) = path.parent() {
                        if let Some(media_id) = parent.file_name().and_then(|n| n.to_str()) {
                            // Extract asset type from filename
                            if let Some(filename) = path.file_stem().and_then(|n| n.to_str()) {
                                let key = format!("{}:{}", media_id, filename);
                                self.lru.put(
                                    key.clone(),
                                    CacheEntry {
                                        path: path.clone(),
                                        size,
                                    },
                                );
                                self.index.insert(key, path);
                                self.current_size += size;
                            }
                        }
                    }
                }
            }
        }
        Ok(())
    }

    /// Generate cache key for a media asset.
    fn cache_key(media_id: &str, asset_type: AssetType) -> String {
        format!("{}:{}", media_id, asset_type.as_str())
    }

    /// Get the path where an asset should be cached.
    fn cache_path(&self, media_id: &str, asset_type: AssetType) -> PathBuf {
        self.cache_dir
            .join(media_id)
            .join(format!("{}.{}", asset_type.as_str(), asset_type.extension()))
    }

    /// Check if an asset is cached and return its path.
    pub fn get_cached_path(&self, media_id: &str, asset_type: AssetType) -> Option<PathBuf> {
        let key = Self::cache_key(media_id, asset_type);
        self.index.get(&key).cloned()
    }

    /// Download and cache an asset.
    pub async fn download_and_cache(
        &mut self,
        client: &reqwest::Client,
        url: &str,
        media_id: &str,
        asset_type: AssetType,
        token: Option<&str>,
    ) -> Result<PathBuf> {
        let key = Self::cache_key(media_id, asset_type);
        let path = self.cache_path(media_id, asset_type);

        // Create media directory
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).context("Failed to create media cache directory")?;
        }

        // Download the file
        tracing::debug!("Downloading {} to {:?}", url, path);

        let mut request = client.get(url);
        if let Some(token) = token {
            request = request.bearer_auth(token);
        }

        let response = request.send().await.context("Failed to send request")?;
        let response = response
            .error_for_status()
            .context("Server returned error")?;

        let bytes = response.bytes().await.context("Failed to read response")?;
        let size = bytes.len() as u64;

        // Check if we need to evict before writing
        while self.current_size + size > self.max_size {
            if !self.evict_lru() {
                tracing::warn!("Cache full and cannot evict, continuing anyway");
                break;
            }
        }

        // Write to file
        let mut file = tokio::fs::File::create(&path)
            .await
            .context("Failed to create cache file")?;
        file.write_all(&bytes)
            .await
            .context("Failed to write cache file")?;
        file.flush().await.context("Failed to flush cache file")?;

        // Update cache index
        self.lru.put(
            key.clone(),
            CacheEntry {
                path: path.clone(),
                size,
            },
        );
        self.index.insert(key, path.clone());
        self.current_size += size;

        tracing::debug!(
            "Cached {} ({:.2} KB), total: {:.2} MB",
            media_id,
            size as f64 / 1024.0,
            self.current_size as f64 / 1024.0 / 1024.0
        );

        Ok(path)
    }

    /// Evict the least recently used item.
    fn evict_lru(&mut self) -> bool {
        if let Some((key, entry)) = self.lru.pop_lru() {
            tracing::debug!("Evicting {:?}", entry.path);

            // Remove the file
            if entry.path.exists() {
                if let Err(e) = fs::remove_file(&entry.path) {
                    tracing::warn!("Failed to remove cached file: {}", e);
                }
            }

            // Try to remove empty parent directory
            if let Some(parent) = entry.path.parent() {
                let _ = fs::remove_dir(parent); // Ignore error if not empty
            }

            self.index.remove(&key);
            self.current_size = self.current_size.saturating_sub(entry.size);

            return true;
        }
        false
    }

    /// Mark an asset as recently used (for LRU tracking).
    pub fn touch(&mut self, media_id: &str, asset_type: AssetType) {
        let key = Self::cache_key(media_id, asset_type);
        // LruCache::get promotes the key to most recently used
        let _ = self.lru.get(&key);
    }

    /// Save the current playlist to cache for offline use.
    pub fn save_playlist(&self, playlist: &[Media]) -> Result<()> {
        let playlist_path = self.cache_dir.join("playlist.json");
        let json = serde_json::to_string_pretty(playlist).context("Failed to serialize playlist")?;
        fs::write(&playlist_path, json).context("Failed to write playlist")?;
        tracing::debug!("Saved playlist with {} items", playlist.len());
        Ok(())
    }

    /// Load the cached playlist.
    pub fn load_playlist(&self) -> Result<Vec<Media>> {
        let playlist_path = self.cache_dir.join("playlist.json");
        if !playlist_path.exists() {
            return Ok(Vec::new());
        }

        let json = fs::read_to_string(&playlist_path).context("Failed to read playlist")?;
        let playlist: Vec<Media> =
            serde_json::from_str(&json).context("Failed to parse playlist")?;
        tracing::info!("Loaded cached playlist with {} items", playlist.len());
        Ok(playlist)
    }

    /// Get cache statistics.
    pub fn stats(&self) -> CacheStats {
        CacheStats {
            current_size: self.current_size,
            max_size: self.max_size,
            item_count: self.lru.len(),
        }
    }

    /// Clean up orphaned cache entries (assets not in current playlist).
    pub fn cleanup_orphans(&mut self, playlist: &[Media]) {
        let playlist_ids: std::collections::HashSet<_> =
            playlist.iter().map(|m| m.id.as_str()).collect();

        let mut to_remove = Vec::new();

        for (key, entry) in self.lru.iter() {
            // Extract media_id from key (format: media_id:asset_type)
            if let Some(media_id) = key.split(':').next() {
                if !playlist_ids.contains(media_id) {
                    to_remove.push((key.clone(), entry.clone()));
                }
            }
        }

        for (key, entry) in to_remove {
            tracing::debug!("Removing orphaned cache entry: {}", key);
            if entry.path.exists() {
                let _ = fs::remove_file(&entry.path);
            }
            if let Some(parent) = entry.path.parent() {
                let _ = fs::remove_dir(parent);
            }
            self.lru.pop(&key);
            self.index.remove(&key);
            self.current_size = self.current_size.saturating_sub(entry.size);
        }
    }
}

/// Cache statistics.
#[derive(Debug, Clone)]
pub struct CacheStats {
    pub current_size: u64,
    pub max_size: u64,
    pub item_count: usize,
}



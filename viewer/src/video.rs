//! GStreamer-based video playback module.
//!
//! Handles video decoding, frame extraction, and seamless looping for short clips.

use anyhow::{Context, Result};
use gstreamer as gst;
use gstreamer::prelude::*;
use gstreamer_app as gst_app;
use gstreamer_video as gst_video;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

/// Video frame extracted from the pipeline.
#[derive(Clone)]
pub struct VideoFrame {
    pub pixels: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

/// State of the video player.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum PlayerState {
    Stopped,
    Playing,
    Paused,
    EndOfStream,
}

/// Video player using GStreamer.
pub struct VideoPlayer {
    pipeline: gst::Pipeline,
    #[allow(dead_code)]
    appsink: gst_app::AppSink,
    current_frame: Arc<Mutex<Option<VideoFrame>>>,
    state: Arc<Mutex<PlayerState>>,
    should_loop: bool,
    #[allow(dead_code)]
    loop_threshold_sec: f32,
    duration: Option<f32>,
    eos_reached: Arc<AtomicBool>,
    /// Bus watch guard - must be kept alive for the watch to remain active.
    /// Dropping this will remove the watch.
    #[allow(dead_code)]
    bus_watch_guard: Option<gst::bus::BusWatchGuard>,
}

impl VideoPlayer {
    /// Initialize GStreamer (call once at startup).
    pub fn init() -> Result<()> {
        gst::init().context("Failed to initialize GStreamer")?;
        tracing::info!("GStreamer initialized: {}", gst::version_string());
        Ok(())
    }

    /// Create a new video player for the given file.
    pub fn new(path: &Path, loop_threshold_sec: f32, media_duration: Option<f32>) -> Result<Self> {
        let uri = if path.starts_with("/") {
            format!("file://{}", path.display())
        } else {
            format!("file://{}", std::fs::canonicalize(path)?.display())
        };

        tracing::debug!("Creating video player for: {}", uri);

        // Build the pipeline
        let pipeline = gst::Pipeline::new();

        // Source
        let src = gst::ElementFactory::make("uridecodebin")
            .name("source")
            .property("uri", &uri)
            .build()
            .context("Failed to create uridecodebin")?;

        // Video conversion
        let convert = gst::ElementFactory::make("videoconvert")
            .name("convert")
            .build()
            .context("Failed to create videoconvert")?;

        // Scale to reasonable size if needed
        let scale = gst::ElementFactory::make("videoscale")
            .name("scale")
            .build()
            .context("Failed to create videoscale")?;

        // App sink for extracting frames
        let appsink = gst_app::AppSink::builder()
            .name("sink")
            .caps(
                &gst_video::VideoCapsBuilder::new()
                    .format(gst_video::VideoFormat::Rgba)
                    .build(),
            )
            .build();

        // Add elements to pipeline
        pipeline
            .add_many([&src, &convert, &scale, appsink.upcast_ref()])
            .context("Failed to add elements to pipeline")?;

        // Link convert -> scale -> appsink
        gst::Element::link_many([&convert, &scale, appsink.upcast_ref()])
            .context("Failed to link elements")?;

        // Handle dynamic pads from uridecodebin
        let convert_weak = convert.downgrade();
        src.connect_pad_added(move |_src, src_pad| {
            let Some(convert) = convert_weak.upgrade() else {
                return;
            };

            let sink_pad = convert
                .static_pad("sink")
                .expect("convert has no sink pad");

            if sink_pad.is_linked() {
                return;
            }

            // Only link video pads
            let caps = src_pad.current_caps().unwrap_or_else(|| src_pad.query_caps(None));
            let structure = caps.structure(0).expect("caps has no structure");
            let name = structure.name();

            if name.starts_with("video/") {
                if let Err(e) = src_pad.link(&sink_pad) {
                    tracing::error!("Failed to link pads: {:?}", e);
                }
            }
        });

        // Set up frame callback
        let current_frame = Arc::new(Mutex::new(None::<VideoFrame>));
        let frame_clone = current_frame.clone();

        appsink.set_callbacks(
            gst_app::AppSinkCallbacks::builder()
                .new_sample(move |appsink| {
                    let sample = appsink.pull_sample().map_err(|_| gst::FlowError::Eos)?;
                    let buffer = sample.buffer().ok_or(gst::FlowError::Error)?;
                    let caps = sample.caps().ok_or(gst::FlowError::Error)?;

                    let video_info =
                        gst_video::VideoInfo::from_caps(caps).map_err(|_| gst::FlowError::Error)?;
                    let width = video_info.width();
                    let height = video_info.height();

                    let map = buffer.map_readable().map_err(|_| gst::FlowError::Error)?;
                    let pixels = map.as_slice().to_vec();

                    let frame = VideoFrame {
                        pixels,
                        width,
                        height,
                    };

                    if let Ok(mut guard) = frame_clone.lock() {
                        *guard = Some(frame);
                    }

                    Ok(gst::FlowSuccess::Ok)
                })
                .build(),
        );

        // Determine if we should loop
        let should_loop = media_duration
            .map(|d| d < loop_threshold_sec)
            .unwrap_or(false);

        let state = Arc::new(Mutex::new(PlayerState::Stopped));
        let eos_reached = Arc::new(AtomicBool::new(false));

        // Set up EOS handling for looping
        let eos_flag = eos_reached.clone();
        let pipeline_weak = pipeline.downgrade();
        let should_loop_copy = should_loop;

        let bus = pipeline.bus().expect("Pipeline has no bus");
        let bus_watch_guard = bus.add_watch(move |_bus, msg| {
            match msg.view() {
                gst::MessageView::Eos(_) => {
                    if should_loop_copy {
                        // Seek back to start for seamless loop
                        if let Some(pipeline) = pipeline_weak.upgrade() {
                            let _ = pipeline.seek_simple(
                                gst::SeekFlags::FLUSH | gst::SeekFlags::KEY_UNIT,
                                gst::ClockTime::ZERO,
                            );
                        }
                    } else {
                        eos_flag.store(true, Ordering::SeqCst);
                    }
                }
                gst::MessageView::Error(err) => {
                    tracing::error!(
                        "GStreamer error: {} ({:?})",
                        err.error(),
                        err.debug()
                    );
                    eos_flag.store(true, Ordering::SeqCst);
                }
                _ => {}
            }
            gst::glib::ControlFlow::Continue
        })
        .expect("Failed to add bus watch");

        Ok(Self {
            pipeline,
            appsink,
            current_frame,
            state,
            should_loop,
            loop_threshold_sec,
            duration: media_duration,
            eos_reached,
            bus_watch_guard: Some(bus_watch_guard),
        })
    }

    /// Start playing the video.
    pub fn play(&self) -> Result<()> {
        self.pipeline
            .set_state(gst::State::Playing)
            .context("Failed to set pipeline to playing")?;

        if let Ok(mut state) = self.state.lock() {
            *state = PlayerState::Playing;
        }

        Ok(())
    }

    /// Pause the video.
    pub fn pause(&self) -> Result<()> {
        self.pipeline
            .set_state(gst::State::Paused)
            .context("Failed to set pipeline to paused")?;

        if let Ok(mut state) = self.state.lock() {
            *state = PlayerState::Paused;
        }

        Ok(())
    }

    /// Stop the video and release resources.
    pub fn stop(&self) -> Result<()> {
        self.pipeline
            .set_state(gst::State::Null)
            .context("Failed to set pipeline to null")?;

        if let Ok(mut state) = self.state.lock() {
            *state = PlayerState::Stopped;
        }

        Ok(())
    }

    /// Get the current frame if available.
    pub fn current_frame(&self) -> Option<VideoFrame> {
        self.current_frame.lock().ok()?.clone()
    }

    /// Check if end of stream has been reached (for non-looping videos).
    pub fn is_eos(&self) -> bool {
        self.eos_reached.load(Ordering::SeqCst)
    }

    /// Get the player state.
    pub fn state(&self) -> PlayerState {
        self.state.lock().ok().map(|s| *s).unwrap_or(PlayerState::Stopped)
    }

    /// Check if this video is set to loop.
    pub fn is_looping(&self) -> bool {
        self.should_loop
    }

    /// Get video duration in seconds.
    pub fn duration(&self) -> Option<f32> {
        self.duration
    }

    /// Get current playback position in seconds.
    pub fn position(&self) -> Option<f32> {
        self.pipeline
            .query_position::<gst::ClockTime>()
            .map(|p| p.seconds() as f32)
    }
}

impl Drop for VideoPlayer {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

/// Manager for video playback state.
pub struct VideoManager {
    current_player: Option<VideoPlayer>,
    loop_threshold_sec: f32,
}

impl VideoManager {
    /// Create a new video manager.
    pub fn new(loop_threshold_sec: f32) -> Self {
        Self {
            current_player: None,
            loop_threshold_sec,
        }
    }

    /// Load and start playing a video.
    pub fn play_video(&mut self, path: &Path, duration: Option<f32>) -> Result<()> {
        // Stop current video if any
        self.stop();

        // Create and start new player
        let player = VideoPlayer::new(path, self.loop_threshold_sec, duration)?;
        player.play()?;
        self.current_player = Some(player);

        Ok(())
    }

    /// Stop current video.
    pub fn stop(&mut self) {
        if let Some(player) = self.current_player.take() {
            let _ = player.stop();
        }
    }

    /// Pause the current video.
    pub fn pause(&mut self) {
        if let Some(ref player) = self.current_player {
            let _ = player.pause();
        }
    }

    /// Resume the current video.
    pub fn resume(&mut self) {
        if let Some(ref player) = self.current_player {
            let _ = player.play();
        }
    }

    /// Get the current video frame.
    pub fn current_frame(&self) -> Option<VideoFrame> {
        self.current_player.as_ref()?.current_frame()
    }

    /// Check if video playback has ended.
    pub fn is_ended(&self) -> bool {
        self.current_player
            .as_ref()
            .map(|p| p.is_eos())
            .unwrap_or(true)
    }

    /// Check if a video is currently playing.
    pub fn is_playing(&self) -> bool {
        self.current_player
            .as_ref()
            .map(|p| p.state() == PlayerState::Playing)
            .unwrap_or(false)
    }

    /// Check if current video is looping.
    pub fn is_looping(&self) -> bool {
        self.current_player
            .as_ref()
            .map(|p| p.is_looping())
            .unwrap_or(false)
    }

    /// Get video duration in seconds.
    pub fn duration(&self) -> Option<f32> {
        self.current_player.as_ref()?.duration()
    }

    /// Get current playback position in seconds.
    pub fn position(&self) -> Option<f32> {
        self.current_player.as_ref()?.position()
    }
}


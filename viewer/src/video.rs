//! GStreamer-based video playback module.
//!
//! Handles video decoding, frame extraction, and seamless looping for short clips.

use anyhow::{Context, Result};
use gstreamer as gst;
use gstreamer::prelude::*;
use gstreamer_app as gst_app;
use gstreamer_video as gst_video;
use gstreamer_video::prelude::*;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

/// Video frame extracted from the pipeline, kept in planar I420 (YUV) rather
/// than converted to RGBA -- SDL2's streaming YUV textures let the GPU do
/// the YUV->RGB conversion during render, instead of paying for it in
/// software every frame (which was slow enough on the Pi's CPU to bottleneck
/// playback even with hardware-accelerated decode).
#[derive(Clone)]
pub struct VideoFrame {
    pub y_plane: Vec<u8>,
    pub y_stride: usize,
    pub u_plane: Vec<u8>,
    pub u_stride: usize,
    pub v_plane: Vec<u8>,
    pub v_stride: usize,
    pub width: u32,
    pub height: u32,
}

/// State of the video player.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum PlayerState {
    Stopped,
    Playing,
    Paused,
}

/// Video player using GStreamer.
pub struct VideoPlayer {
    pipeline: gst::Pipeline,
    #[allow(dead_code)]
    appsink: gst_app::AppSink,
    current_frame: Arc<Mutex<Option<VideoFrame>>>,
    state: Arc<Mutex<PlayerState>>,
    duration: Option<f32>,
    started_at: std::time::Instant,
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

    /// Build an explicit hardware-decode pipeline: filesrc ! qtdemux !
    /// h264parse ! v4l2h264dec ! videoscale ! appsink (I420). All our own
    /// transcoded videos are H.264/AAC MP4 (see backend/pb_hooks/utils.js),
    /// so this covers normal playback; anything unusual falls back to
    /// `build_sw_pipeline` below. Fails fast (before any state change) if
    /// `v4l2h264dec` isn't available on this system -- e.g. on non-Linux dev
    /// machines, which have no V4L2 stack at all.
    ///
    /// No `videoconvert` here deliberately: v4l2h264dec negotiates directly
    /// to plain system-memory I420 when that's what's requested downstream
    /// (verified empirically), so there's nothing for videoconvert to do --
    /// and forcing RGBA/videoconvert into this chain was the actual
    /// bottleneck (a 6s clip took 29s to decode+convert vs ~3s without it).
    fn build_hw_pipeline(path: &Path) -> Result<(gst::Pipeline, gst_app::AppSink)> {
        let location = path.to_str().context("Video path is not valid UTF-8")?;

        let pipeline = gst::Pipeline::new();

        let src = gst::ElementFactory::make("filesrc")
            .name("source")
            .property("location", location)
            .build()
            .context("filesrc unavailable")?;
        let demux = gst::ElementFactory::make("qtdemux")
            .name("demux")
            .build()
            .context("qtdemux unavailable")?;
        let parse = gst::ElementFactory::make("h264parse")
            .name("parse")
            .build()
            .context("h264parse unavailable")?;
        let decoder = gst::ElementFactory::make("v4l2h264dec")
            .name("decoder")
            .build()
            .context("v4l2h264dec unavailable")?;
        let scale = gst::ElementFactory::make("videoscale")
            .name("scale")
            .build()
            .context("videoscale unavailable")?;
        let appsink = gst_app::AppSink::builder()
            .name("sink")
            .caps(
                &gst_video::VideoCapsBuilder::new()
                    .format(gst_video::VideoFormat::I420)
                    .build(),
            )
            .build();

        pipeline
            .add_many([&src, &demux, &parse, &decoder, &scale, appsink.upcast_ref()])
            .context("Failed to add hardware-decode elements to pipeline")?;

        gst::Element::link(&src, &demux).context("Failed to link filesrc -> qtdemux")?;
        gst::Element::link_many([&parse, &decoder, &scale, appsink.upcast_ref()])
            .context("Failed to link h264parse -> v4l2h264dec -> videoscale -> appsink")?;

        // qtdemux exposes its track pads dynamically; link only the video one.
        let parse_weak = parse.downgrade();
        demux.connect_pad_added(move |_demux, src_pad| {
            let Some(parse) = parse_weak.upgrade() else {
                return;
            };
            let Some(sink_pad) = parse.static_pad("sink") else {
                return;
            };
            if sink_pad.is_linked() {
                return;
            }
            let caps = src_pad
                .current_caps()
                .unwrap_or_else(|| src_pad.query_caps(None));
            let Some(structure) = caps.structure(0) else {
                return;
            };
            if structure.name().starts_with("video/") {
                if let Err(e) = src_pad.link(&sink_pad) {
                    tracing::error!("Failed to link qtdemux video pad: {:?}", e);
                }
            }
        });

        Ok((pipeline, appsink))
    }

    /// Software-decode fallback: uridecodebin ! videoconvert ! videoscale !
    /// appsink, with the decoder chosen by GStreamer's autoplugger. Used
    /// when hardware decode isn't available on this system.
    fn build_sw_pipeline(uri: &str) -> Result<(gst::Pipeline, gst_app::AppSink)> {
        let pipeline = gst::Pipeline::new();

        let src = gst::ElementFactory::make("uridecodebin")
            .name("source")
            .property("uri", uri)
            .build()
            .context("Failed to create uridecodebin")?;

        let convert = gst::ElementFactory::make("videoconvert")
            .name("convert")
            .build()
            .context("Failed to create videoconvert")?;

        let scale = gst::ElementFactory::make("videoscale")
            .name("scale")
            .build()
            .context("Failed to create videoscale")?;

        let appsink = gst_app::AppSink::builder()
            .name("sink")
            .caps(
                &gst_video::VideoCapsBuilder::new()
                    .format(gst_video::VideoFormat::I420)
                    .build(),
            )
            .build();

        pipeline
            .add_many([&src, &convert, &scale, appsink.upcast_ref()])
            .context("Failed to add elements to pipeline")?;

        gst::Element::link_many([&convert, &scale, appsink.upcast_ref()])
            .context("Failed to link elements")?;

        let convert_weak = convert.downgrade();
        src.connect_pad_added(move |_src, src_pad| {
            let Some(convert) = convert_weak.upgrade() else {
                return;
            };

            let sink_pad = convert.static_pad("sink").expect("convert has no sink pad");

            if sink_pad.is_linked() {
                return;
            }

            // Only link video pads
            let caps = src_pad
                .current_caps()
                .unwrap_or_else(|| src_pad.query_caps(None));
            let structure = caps.structure(0).expect("caps has no structure");
            let name = structure.name();

            if name.starts_with("video/") {
                if let Err(e) = src_pad.link(&sink_pad) {
                    tracing::error!("Failed to link pads: {:?}", e);
                }
            }
        });

        Ok((pipeline, appsink))
    }

    /// Create a new video player for the given file.
    pub fn new(path: &Path, media_duration: Option<f32>) -> Result<Self> {
        let uri = if path.starts_with("/") {
            format!("file://{}", path.display())
        } else {
            format!("file://{}", std::fs::canonicalize(path)?.display())
        };

        tracing::debug!("Creating video player for: {}", uri);

        let (pipeline, appsink) = match Self::build_hw_pipeline(path) {
            Ok(built) => {
                tracing::debug!("Video decode: using hardware (v4l2h264dec)");
                built
            }
            Err(e) => {
                tracing::warn!(
                    "Hardware video decode unavailable ({e:#}), falling back to software decode"
                );
                Self::build_sw_pipeline(&uri)?
            }
        };

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

                    let video_frame =
                        gst_video::VideoFrameRef::from_buffer_ref_readable(buffer, &video_info)
                            .map_err(|_| gst::FlowError::Error)?;

                    let strides = video_frame.plane_stride();
                    let (y_stride, u_stride, v_stride) = (
                        strides[0] as usize,
                        strides[1] as usize,
                        strides[2] as usize,
                    );

                    let y_plane = video_frame
                        .plane_data(0)
                        .map_err(|_| gst::FlowError::Error)?
                        .to_vec();
                    let u_plane = video_frame
                        .plane_data(1)
                        .map_err(|_| gst::FlowError::Error)?
                        .to_vec();
                    let v_plane = video_frame
                        .plane_data(2)
                        .map_err(|_| gst::FlowError::Error)?
                        .to_vec();

                    let frame = VideoFrame {
                        y_plane,
                        y_stride,
                        u_plane,
                        u_stride,
                        v_plane,
                        v_stride,
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

        let state = Arc::new(Mutex::new(PlayerState::Stopped));
        let eos_reached = Arc::new(AtomicBool::new(false));

        // Every video plays exactly once, at its own natural length -- the
        // slide-advance timing in main.rs is driven by this EOS, not a fixed
        // interval, so there's nothing to gain from looping to fill time.
        let eos_flag = eos_reached.clone();
        let bus = pipeline.bus().expect("Pipeline has no bus");
        let bus_watch_guard = bus
            .add_watch(move |_bus, msg| {
                match msg.view() {
                    gst::MessageView::Eos(_) => {
                        eos_flag.store(true, Ordering::SeqCst);
                    }
                    gst::MessageView::Error(err) => {
                        tracing::error!("GStreamer error: {} ({:?})", err.error(), err.debug());
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
            duration: media_duration,
            started_at: std::time::Instant::now(),
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

    /// Take the current frame if a new one has arrived since the last call.
    /// Uses `take()` rather than `clone()` so unchanged frames aren't
    /// re-fetched (and re-uploaded to the GPU) every render-loop tick.
    pub fn current_frame(&self) -> Option<VideoFrame> {
        self.current_frame.lock().ok()?.take()
    }

    /// Check if playback has finished. Prefers the real EOS bus message, but
    /// falls back to elapsed-time-vs-known-duration: some hardware decode
    /// pipeline configurations (observed with v4l2h264dec on the Pi) don't
    /// reliably post EOS to the bus, which would otherwise leave playback
    /// stuck waiting forever once the last frame has already been shown.
    pub fn is_eos(&self) -> bool {
        if self.eos_reached.load(Ordering::SeqCst) {
            return true;
        }
        if let Some(duration) = self.duration {
            if self.started_at.elapsed().as_secs_f32() >= duration + 0.5 {
                return true;
            }
        }
        false
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
#[derive(Default)]
pub struct VideoManager {
    current_player: Option<VideoPlayer>,
}

impl VideoManager {
    /// Create a new video manager.
    pub fn new() -> Self {
        Self::default()
    }

    /// Load and start playing a video.
    pub fn play_video(&mut self, path: &Path, duration: Option<f32>) -> Result<()> {
        // Stop current video if any
        self.stop();

        // Create and start new player
        let player = VideoPlayer::new(path, duration)?;
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

    /// Get video duration in seconds.
    pub fn duration(&self) -> Option<f32> {
        self.current_player.as_ref()?.duration()
    }

    /// Get current playback position in seconds.
    pub fn position(&self) -> Option<f32> {
        self.current_player.as_ref()?.position()
    }
}

const $ = (id) => document.getElementById(id);

/* ---------- Shared state (declared first so nothing hits a late declaration) ---------- */
let mode = "caption";
let platform = "YouTube";
let tone = "Professional";

let lastResults = { captions: [], hooks: [], tags: [] };
let generationHistory = []; // renamed from `history` so it never clashes with window.history
let toastTimer;

/* ---------- Notifications ---------- */
function notify(message) {
  const toast = $("toast");
  if (!toast) return;
  toast.textContent = message;
  toast.classList.remove("hidden");

  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add("hidden"), 2200);
}

/* ---------- Copy helper ---------- */
async function copyText(text) {
  if (!text) {
    notify("Generate some content first.");
    return;
  }

  try {
    await navigator.clipboard.writeText(text);
    notify("Copied to clipboard!");
  } catch {
    const input = document.createElement("textarea");
    input.value = text;
    input.style.position = "fixed";
    input.style.opacity = "0";
    document.body.append(input);
    input.select();
    const success = document.execCommand("copy");
    input.remove();
    notify(success ? "Copied to clipboard!" : "Copy failed. Please select the text.");
  }
}

/* ---------- Video upload + preview ---------- */
const videoFileInput = $("videoFile");
const videoPreview = $("videoPreview");
const videoFileName = $("videoFileName");
let currentVideoUrl = null;
let currentTrackUrl = null;

function clearTracks() {
  if (!videoPreview) return;
  videoPreview.querySelectorAll("track").forEach((t) => t.remove());
  if (currentTrackUrl) {
    URL.revokeObjectURL(currentTrackUrl);
    currentTrackUrl = null;
  }
}

if (videoFileInput && videoPreview && videoFileName) {
  videoFileInput.addEventListener("change", () => {
    const file = videoFileInput.files[0];
    if (!file) return;

    if (!file.type.startsWith("video/")) {
      notify("Please select a video file.");
      videoFileInput.value = "";
      return;
    }

    if (currentVideoUrl) URL.revokeObjectURL(currentVideoUrl);
    clearTracks(); // remove captions that belonged to the previous video
    currentVideoUrl = URL.createObjectURL(file);

    videoPreview.src = currentVideoUrl;
    videoPreview.hidden = false;
    videoFileName.textContent = file.name;
    $("captionOutput").replaceChildren();
    $("captionStatus").textContent = "Ready. Click Generate Auto Captions.";
    notify("Video loaded! You can preview it now.");
  });
}

/* ---------- Auto captions (Whisper running in the browser) ---------- */
const autoCaptionBtn = $("autoCaptionBtn");
const captionLanguage = $("captionLanguage");
const captionStatus = $("captionStatus");
const captionOutput = $("captionOutput");

const MAX_VIDEO_MB = 300;

let transcriberPromise = null;
let loadedModel = null;

function getTranscriber(model) {
  if (loadedModel !== model || !transcriberPromise) {
    loadedModel = model;
    transcriberPromise = import(
      "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.0.2"
    )
      .then(({ pipeline }) =>
        pipeline("automatic-speech-recognition", model, {
          progress_callback: (p) => {
            if (p.status === "progress" && typeof p.progress === "number") {
              captionStatus.textContent =
                `Downloading speech model… ${Math.round(p.progress)}% (first time only)`;
            }
          }
        })
      )
      .catch((err) => {
        // Reset so the next click can retry instead of reusing a failed promise
        transcriberPromise = null;
        loadedModel = null;
        throw err;
      });
  }
  return transcriberPromise;
}

async function extractAudio(file) {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) throw new Error("AUDIO_UNSUPPORTED");

  const buffer = await file.arrayBuffer();
  const ctx = new AudioCtx({ sampleRate: 16000 });

  let decoded;
  try {
    decoded = await ctx.decodeAudioData(buffer);
  } catch (e) {
    throw new Error("DECODE_FAILED");
  } finally {
    ctx.close();
  }

  if (decoded.numberOfChannels < 2) return decoded.getChannelData(0);

  const left = decoded.getChannelData(0);
  const right = decoded.getChannelData(1);
  const mono = new Float32Array(left.length);
  for (let i = 0; i < left.length; i++) mono[i] = (left[i] + right[i]) / 2;
  return mono;
}

// Fixed: rounding the total milliseconds avoids ".1000" glitches
function formatTime(sec, sep) {
  const total = Math.max(0, Math.round(sec * 1000));
  const ms = total % 1000;
  const s = Math.floor(total / 1000) % 60;
  const m = Math.floor(total / 60000) % 60;
  const h = Math.floor(total / 3600000);
  const p = (n, l = 2) => String(n).padStart(l, "0");
  return `${p(h)}:${p(m)}:${p(s)}${sep}${p(ms, 3)}`;
}

function buildSubtitles(chunks, type) {
  const sep = type === "vtt" ? "." : ",";
  const body = chunks
    .map((c, i) => {
      const start = c.timestamp?.[0] ?? 0;
      const end = c.timestamp?.[1] ?? start + 3;
      return `${i + 1}\n${formatTime(start, sep)} --> ${formatTime(end, sep)}\n${c.text.trim()}\n`;
    })
    .join("\n");
  return type === "vtt" ? "WEBVTT\n\n" + body : body;
}

function downloadFile(name, content, mime) {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  // Delay revoke so the browser can start the download first
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function attachTrack(vtt, lang) {
  clearTracks();

  currentTrackUrl = URL.createObjectURL(new Blob([vtt], { type: "text/vtt" }));

  const track = document.createElement("track");
  track.kind = "captions";
  track.label = "Auto captions";
  track.srclang = lang;
  track.default = true;
  track.src = currentTrackUrl;
  videoPreview.append(track);

  // Force the captions to show (default alone isn't reliable in every browser)
  // Captions are drawn by our own styled overlay (captionstyles.js),
  // so the browser's built-in caption display stays hidden.
  track.addEventListener("load", () => {
    track.track.mode = "hidden";
  });
  track.track.mode = "hidden";
}

function renderCaptions(chunks, lang) {
  captionOutput.replaceChildren();

  chunks.forEach((c) => {
    const line = document.createElement("div");
    line.className = "caption-line";

    const time = document.createElement("time");
    time.textContent = formatTime(c.timestamp?.[0] ?? 0, ".").slice(3, 8);

    const text = document.createElement("span");
    text.textContent = c.text.trim();

    line.append(time, text);
    captionOutput.append(line);
  });

  const actions = document.createElement("div");
  actions.className = "caption-actions";

  const makeBtn = (label, fn) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "copy";
    b.textContent = label;
    b.addEventListener("click", fn);
    actions.append(b);
  };

  makeBtn("Download .srt", () =>
    downloadFile("captions.srt", buildSubtitles(chunks, "srt"), "text/plain"));
  makeBtn("Download .vtt", () =>
    downloadFile("captions.vtt", buildSubtitles(chunks, "vtt"), "text/vtt"));
  makeBtn("Copy text", () =>
    copyText(chunks.map((c) => c.text.trim()).join(" ")));

  captionOutput.append(actions);
  attachTrack(buildSubtitles(chunks, "vtt"), lang);

  // Tell the caption-style module that new captions are ready
  if (window.onCaptionsReady) window.onCaptionsReady(chunks);
}

if (autoCaptionBtn) {
  autoCaptionBtn.addEventListener("click", async () => {
    const file = videoFileInput && videoFileInput.files[0];
    if (!file) {
      captionStatus.textContent = "Please upload a video first.";
      return;
    }

    if (file.size > MAX_VIDEO_MB * 1024 * 1024) {
      captionStatus.textContent =
        `This video is larger than ${MAX_VIDEO_MB} MB. Please use a shorter or smaller video.`;
      return;
    }

    const language = captionLanguage.value; // english | nepali | hindi
    const model = language === "english"
      ? "Xenova/whisper-base"
      : "Xenova/whisper-small"; // better for Nepali/Hindi, larger download

    autoCaptionBtn.disabled = true;
    captionOutput.replaceChildren();

    try {
      captionStatus.textContent = "Reading audio from video…";
      const audio = await extractAudio(file);

      captionStatus.textContent = "Loading speech model…";
      const transcriber = await getTranscriber(model);

      captionStatus.textContent = "Transcribing… this can take a few minutes. The page may feel slow meanwhile.";
      // Let the browser paint the message before the heavy work starts
      await new Promise((resolve) => setTimeout(resolve, 50));

      const result = await transcriber(audio, {
        language,
        task: "transcribe",
        return_timestamps: true,
        chunk_length_s: 30,
        stride_length_s: 5
      });

      const chunks = (result.chunks || []).filter((c) => c.text.trim());
      if (!chunks.length) {
        captionStatus.textContent = "No speech was detected in this video.";
        return;
      }

      renderCaptions(chunks, language.slice(0, 2));
      captionStatus.textContent = "Done! Captions are also showing on your video.";
      notify("Captions ready!");
    } catch (err) {
      console.error(err);
      if (err.message === "DECODE_FAILED") {
        captionStatus.textContent =
          "Your browser couldn't read the audio in this file. Try an MP4 (H.264/AAC) video.";
      } else if (err.message === "AUDIO_UNSUPPORTED") {
        captionStatus.textContent = "This browser doesn't support audio processing. Try Chrome or Edge.";
      } else {
        captionStatus.textContent =
          "Something went wrong. Check your internet connection (needed to download the model once) or try a shorter video.";
      }
    } finally {
      autoCaptionBtn.disabled = false;
    }
  });
}

/* ---------- Generator controls ---------- */

// Character counter
$("topic").addEventListener("input", () => {
  $("count").textContent = $("topic").value.length + "/200";
});

// Generator tabs
document.querySelectorAll("[data-mode]").forEach((button) => {
  button.addEventListener("click", () => {
    mode = button.dataset.mode;

    document.querySelectorAll("[data-mode]").forEach((item) => {
      const active = item === button;
      item.classList.toggle("active", active);
      item.setAttribute("aria-selected", String(active));
    });

    const labels = {
      caption: "Generate Captions",
      hook: "Generate Hooks",
      hashtags: "Generate Hashtags"
    };

    $("generate").textContent = "✧  " + labels[mode];
  });
});

// Platform selection
document.querySelectorAll("[data-platform]").forEach((button) => {
  button.addEventListener("click", () => {
    platform = button.dataset.platform;

    document.querySelectorAll("[data-platform]").forEach((item) => {
      const active = item === button;
      item.classList.toggle("active", active);
      item.setAttribute("aria-pressed", String(active));
    });
  });
});

// Tone selection
document.querySelectorAll("[data-tone]").forEach((button) => {
  button.addEventListener("click", () => {
    tone = button.dataset.tone;

    document.querySelectorAll("[data-tone]").forEach((item) => {
      const active = item === button;
      item.classList.toggle("active", active);
      item.setAttribute("aria-pressed", String(active));
    });
  });
});

// Clean up the user's topic
function cleanTopic(value) {
  return value.trim().replace(/\s+/g, " ").replace(/[.!?]+$/, "");
}

// Generate captions, hooks and hashtags
function makeResults(topic) {
  const subject = topic;
  const lower = subject.toLowerCase();
  const words = lower.match(/[a-z0-9]+/g) || [];

  const tags = [
    ...new Set([
      ...words.filter((word) => word.length > 2).slice(0, 4),
      "contentcreator",
      "shorts",
      "reels",
      "creatorlife"
    ])
  ]
    .slice(0, 8)
    .map((word) => "#" + word);

  let captions;
  let hooks;

  if (tone === "Funny") {
    captions = [
      `${subject} had no business being this funny 😂 What would you do?`,
      `POV: You thought ${subject} would be easy. Plot twist 😂`,
      `I can't be the only one thinking about ${subject} 😭👇`
    ];
    hooks = [
      `Nobody warned me about ${subject} 😂`,
      `I have questions about ${subject} 💀`,
      `Tell me this isn't just me and ${subject} 👀`
    ];
  } else if (tone === "Casual") {
    captions = [
      `Let's talk about ${subject} 👀 What do you think?`,
      `A little something about ${subject} ✨ Save this for later!`,
      `Sharing this because ${subject} deserves more attention 🙌`
    ];
    hooks = [
      `Wait, have you tried this with ${subject}? 👀`,
      `Let's make ${subject} easier.`,
      `Here's something about ${subject} you might like.`
    ];
  } else if (tone === "Inspirational") {
    captions = [
      `Every big journey starts somewhere. Here's a reminder about ${subject} ✨`,
      `Keep learning, keep growing. Your next step starts with ${subject} 💜`,
      `Small steps create big change. Let ${subject} inspire your next move 🚀`
    ];
    hooks = [
      `This could change how you approach ${subject} ✨`,
      `Here's your reminder to keep going with ${subject} 💜`,
      `One small step toward understanding ${subject} 🚀`
    ];
  } else {
    captions = [
      `Everything you need to know about ${subject}. Save this for later.`,
      `A closer look at ${subject} — here's what matters most.`,
      `Let's break down ${subject}. Share your thoughts below.`
    ];
    hooks = [
      `3 things to know about ${subject}.`,
      `Before you try ${subject}, watch this.`,
      `Here's what people often miss about ${subject}.`
    ];
  }

  // Customize results for the selected platform
  if (platform === "TikTok") {
    hooks[0] = `Stop scrolling if you're interested in ${subject} 👀`;
  }
  if (platform === "Instagram") {
    captions[0] += "\nDouble-tap if you agree 💜";
  }
  if (platform === "X") {
    captions[0] = `${subject}: here's the part worth talking about.`;
  }

  return { captions, hooks, tags };
}

// Safely display captions and hooks
function renderTextResults(container, items, prefix) {
  container.replaceChildren();

  items.forEach((text, index) => {
    const card = document.createElement("div");
    card.className = "text-result";

    const content = document.createElement("div");
    content.className = "result-text";
    content.textContent = text;

    const button = document.createElement("button");
    button.className = "copy";
    button.textContent = "Copy";
    button.setAttribute("aria-label", `Copy ${prefix} ${index + 1}`);
    button.addEventListener("click", () => copyText(text));

    card.append(content, button);
    container.append(card);
  });
}

// Display hashtags
function renderTags(tags) {
  $("tagResults").replaceChildren();

  tags.forEach((tag) => {
    const span = document.createElement("span");
    span.className = "tag";
    span.textContent = tag;
    $("tagResults").append(span);
  });
}

// Main generation function
function generate() {
  const topic = cleanTopic($("topic").value);

  if (!topic) {
    $("topic").focus();
    notify("Enter your video topic first.");
    return;
  }

  lastResults = makeResults(topic);

  renderTextResults($("captionResults"), lastResults.captions, "caption");
  renderTextResults($("hookResults"), lastResults.hooks, "hook");
  renderTags(lastResults.tags);

  generationHistory.unshift({
    topic,
    captions: [...lastResults.captions],
    hooks: [...lastResults.hooks],
    tags: [...lastResults.tags]
  });
  generationHistory = generationHistory.slice(0, 20);

  notify("Your content ideas are ready!");

  const target =
    mode === "hook"
      ? $("hookResults")
      : mode === "hashtags"
        ? $("tagResults")
        : $("captionResults");

  if (window.matchMedia("(max-width: 700px)").matches) {
    target.scrollIntoView({ behavior: "smooth", block: "center" });
  }
}

$("generate").addEventListener("click", generate);

// Copy hashtags
$("copyTags").addEventListener("click", () => {
  copyText(lastResults.tags.join(" "));
});

// Copy all results
$("copyAll").addEventListener("click", () => {
  if (!lastResults.captions.length) {
    notify("Generate some content first.");
    return;
  }

  const all = [
    "CAPTIONS",
    ...lastResults.captions,
    "",
    "HOOKS",
    ...lastResults.hooks,
    "",
    "HASHTAGS",
    lastResults.tags.join(" ")
  ].join("\n");

  copyText(all);
});

// Fill and generate a sample topic
$("example").addEventListener("click", () => {
  $("topic").value = "5 useful video editing tips for beginners";
  $("count").textContent = $("topic").value.length + "/200";
  generate();
});

/* ---------- Navigation ---------- */
function setPage(page) {
  document.querySelectorAll("[data-page]").forEach((button) => {
    button.classList.toggle("active", button.dataset.page === page);
  });

  if (page === "Generate") {
    $("generatorSection").scrollIntoView({ behavior: "smooth" });
    $("topic").focus({ preventScroll: true });
    return;
  }

  if (page === "History") {
    if (!generationHistory.length) {
      notify("Your history will appear after your first generation.");
      return;
    }

    const item = generationHistory[0];

    $("topic").value = item.topic;
    $("count").textContent = item.topic.length + "/200";

    lastResults = {
      captions: [...item.captions],
      hooks: [...item.hooks],
      tags: [...item.tags]
    };

    renderTextResults($("captionResults"), item.captions, "caption");
    renderTextResults($("hookResults"), item.hooks, "hook");
    renderTags(item.tags);

    notify("Showing your latest result.");
    return;
  }

  if (page === "Favorites") {
    notify("Favorites will be added in a future version.");
    return;
  }

  if (page === "Settings") {
    notify("Settings will be added in a future version.");
    return;
  }

  window.scrollTo({ top: 0, behavior: "smooth" });
}

document.querySelectorAll("[data-page]").forEach((button) => {
  button.addEventListener("click", () => setPage(button.dataset.page));
});

/* ---------- Time-based greeting ---------- */
const hour = new Date().getHours();

$("greeting").textContent =
  (hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening") +
  ", Creator ✨";


/* ===== Caption template styles (injected so no extra CSS file is needed) ===== */
(function injectCaptionCSS() {
  if (document.getElementById("captionflow-style-css")) return;
  const style = document.createElement("style");
  style.id = "captionflow-style-css";
  style.textContent = "/* ===== Video stage + caption overlay ===== */\n.video-stage {\n  position: relative;\n  width: fit-content;\n  max-width: 100%;\n  margin: 0 auto;\n  background: #000;\n  border-radius: 12px;\n  overflow: hidden;\n}\n\n.video-stage video {\n  display: block;\n  width: auto !important;\n  max-width: 100%;\n  max-height: 360px;\n  margin: 0 auto;\n  border-radius: 0 !important;\n}\n\n/* Keep the stage (black box) hidden until a video is chosen.\n   Without this, display:block above overrides the video's hidden attribute. */\n.video-stage video[hidden] { display: none; }\n.video-stage:has(video[hidden]) { display: none; }\n\n.cap-overlay {\n  position: absolute;\n  left: 0;\n  right: 0;\n  bottom: var(--cap-bottom, 14%);\n  display: flex;\n  justify-content: center;\n  padding: 0 5%;\n  pointer-events: none;\n  z-index: 2;\n}\n\n.cap-text {\n  display: inline-block;\n  max-width: 100%;\n  font-size: var(--cap-size, 16px);\n  font-weight: 800;\n  line-height: 1.25;\n  text-align: center;\n  text-wrap: balance;\n  overflow-wrap: anywhere;\n  font-family: Inter, \"Segoe UI\", system-ui, sans-serif;\n}\n\n.cap-overlay .cap-text:empty { display: none; }\n.video-stage.caps-upper .cap-overlay .cap-text { text-transform: uppercase; }\n\n.cap-fs {\n  position: absolute;\n  top: 8px;\n  right: 8px;\n  z-index: 3;\n  border: 0;\n  border-radius: 8px;\n  padding: 5px 9px;\n  background: rgba(0, 0, 0, .55);\n  color: #fff;\n}\n.cap-fs[hidden] { display: none; }\n\n.video-stage:fullscreen {\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  width: 100%;\n  max-width: none;\n  border-radius: 0;\n}\n.video-stage:fullscreen video {\n  max-height: 100vh;\n  max-width: 100vw;\n  height: 100vh;\n  object-fit: contain;\n}\n\n/* ===== 10 caption templates ===== */\n\n/* 1. Classic */\n.cap-t-classic {\n  color: #fff;\n  background: rgba(0, 0, 0, .75);\n  padding: .15em .5em;\n  border-radius: .25em;\n  font-weight: 700;\n}\n\n/* 2. Neon Glow */\n.cap-t-neon {\n  color: #fff;\n  letter-spacing: .02em;\n  text-shadow: 0 0 .08em #fff, 0 0 .3em #22d3ee, 0 0 .6em #22d3ee, 0 0 1em #ec4899;\n}\n\n/* 3. Sunset */\n.cap-t-sunset {\n  font-weight: 900;\n  background: linear-gradient(90deg, #ff9a3c, #ff4f81, #c13bff);\n  -webkit-background-clip: text;\n  background-clip: text;\n  color: transparent;\n  -webkit-text-fill-color: transparent;\n  filter: drop-shadow(0 .05em .08em rgba(0, 0, 0, .75)) drop-shadow(0 0 .03em #000);\n}\n\n/* 4. Yellow Pop */\n.cap-t-pop {\n  color: #ffe600;\n  font-weight: 900;\n  text-transform: uppercase;\n  -webkit-text-stroke: .13em #000;\n  paint-order: stroke fill;\n  text-shadow: 0 .07em 0 #000;\n}\n\n/* 5. Purple Box */\n.cap-t-purple {\n  color: #fff;\n  background: linear-gradient(135deg, #7c3aed, #c026d3);\n  padding: .2em .6em;\n  border-radius: .5em;\n  box-shadow: 0 .1em .4em rgba(124, 58, 237, .6);\n}\n\n/* 6. Comic */\n.cap-t-comic {\n  color: #fff700;\n  background: #ff2e88;\n  padding: .15em .5em;\n  border: .07em solid #000;\n  box-shadow: .12em .12em 0 #000;\n  transform: rotate(-1.5deg);\n  font-family: \"Comic Sans MS\", \"Chalkboard SE\", \"Comic Neue\", cursive, sans-serif;\n}\n\n/* 7. Ocean */\n.cap-t-ocean {\n  color: #fff;\n  background: linear-gradient(90deg, #06b6d4, #3b82f6, #10b981);\n  padding: .2em .7em;\n  border-radius: .8em;\n  text-shadow: 0 .05em .1em rgba(0, 0, 0, .35);\n}\n\n/* 8. Cyber Green */\n.cap-t-cyber {\n  color: #b6ff3b;\n  background: rgba(8, 12, 8, .85);\n  padding: .15em .55em;\n  border: .06em solid #b6ff3b;\n  border-radius: .2em;\n  box-shadow: 0 0 .5em rgba(182, 255, 59, .55);\n  font-family: \"Courier New\", ui-monospace, monospace;\n  letter-spacing: .03em;\n}\n\n/* 9. Gold Luxury */\n.cap-t-gold {\n  font-family: Georgia, \"Times New Roman\", serif;\n  letter-spacing: .03em;\n  background: linear-gradient(180deg, #fff3b0, #f5c542 45%, #b8860b);\n  -webkit-background-clip: text;\n  background-clip: text;\n  color: transparent;\n  -webkit-text-fill-color: transparent;\n  filter: drop-shadow(0 .05em .06em rgba(0, 0, 0, .85)) drop-shadow(0 0 .03em #000);\n}\n\n/* 10. Rainbow */\n.cap-t-rainbow {\n  font-weight: 900;\n  background: linear-gradient(90deg, #ff3b3b, #ffb300, #38d430, #00c3ff, #8a4dff, #ff3bd4, #ff3b3b);\n  background-size: 200% 100%;\n  -webkit-background-clip: text;\n  background-clip: text;\n  color: transparent;\n  -webkit-text-fill-color: transparent;\n  filter: drop-shadow(0 .05em .08em rgba(0, 0, 0, .8)) drop-shadow(0 0 .03em #000);\n  animation: capflow 3s linear infinite;\n}\n\n@keyframes capflow {\n  to { background-position: 200% 0; }\n}\n\n@media (prefers-reduced-motion: reduce) {\n  .cap-t-rainbow { animation: none; }\n}\n\n/* ===== Style panel ===== */\n.style-panel {\n  margin-top: 16px;\n  padding: 14px;\n  border: 1px solid var(--border);\n  border-radius: 12px;\n  background: var(--panel2);\n}\n.style-panel[hidden] { display: none; }\n\n.style-title { font-weight: 700; margin-bottom: 10px; }\n\n.tpl-grid {\n  display: grid;\n  grid-template-columns: repeat(5, minmax(0, 1fr));\n  gap: 8px;\n}\n\n.tpl-btn {\n  display: grid;\n  gap: 6px;\n  justify-items: center;\n  align-content: center;\n  min-height: 74px;\n  padding: 8px 4px;\n  border: 1px solid var(--border);\n  border-radius: 10px;\n  background: #0d0c16;\n  color: var(--muted);\n  font-size: 11px;\n}\n.tpl-btn .cap-text { font-size: 20px; }\n.tpl-btn.active {\n  border-color: #976cff;\n  box-shadow: inset 0 0 0 1px #8253ff;\n  color: #fff;\n}\n\n.style-controls {\n  display: grid;\n  grid-template-columns: repeat(2, minmax(0, 1fr));\n  gap: 12px 16px;\n  margin-top: 14px;\n  align-items: center;\n}\n.style-controls label {\n  display: grid;\n  gap: 4px;\n  font-size: 12px;\n  color: #d3cde4;\n}\n.style-controls input[type=\"range\"] { width: 100%; accent-color: #8052ff; }\n.style-controls .check { display: flex; align-items: center; gap: 8px; }\n.style-actions { display: flex; gap: 8px; flex-wrap: wrap; }\n.style-actions .btn { padding: 9px 12px; font-size: 12px; }\n\n.style-hint { margin: 12px 0 0; font-size: 11px; }\n\n/* Editable caption lines */\n.caption-line span[contenteditable=\"true\"] {\n  flex: 1;\n  border-radius: 6px;\n  padding: 0 4px;\n  outline: none;\n}\n.caption-line span[contenteditable=\"true\"]:focus {\n  background: #0d0c16;\n  box-shadow: 0 0 0 1px #976cff;\n}\n.caption-line time { cursor: pointer; }\n\n@media (max-width: 700px) {\n  .tpl-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }\n  .style-controls { grid-template-columns: 1fr; }\n}\n\nlabel.btn { display: inline-block; cursor: pointer; }\nselect { font: inherit; }\nselect.chip { cursor: pointer; margin-bottom: 4px; }\n";
  document.head.append(style);
})();

/* ===== Caption templates, live overlay, auto adjust, editing ===== */
/* CaptionFlow – styled captions: 10 templates, live overlay, auto adjust, editing.
   Load AFTER script.js:  <script src="captionstyles.js" defer></script> */
(() => {
  // Safety: if this file is loaded twice, do nothing the second time
  if (window.__captionStylesLoaded) return;
  window.__captionStylesLoaded = true;
  console.log("CaptionFlow caption styles loaded");
  const video = document.getElementById("videoPreview");
  const output = document.getElementById("captionOutput");
  const fileInput = document.getElementById("videoFile");
  if (!video || !output) return;

  const TEMPLATES = [
    { id: "classic", name: "Classic" },
    { id: "neon", name: "Neon Glow" },
    { id: "sunset", name: "Sunset" },
    { id: "pop", name: "Yellow Pop" },
    { id: "purple", name: "Purple Box" },
    { id: "comic", name: "Comic" },
    { id: "ocean", name: "Ocean" },
    { id: "cyber", name: "Cyber Green" },
    { id: "gold", name: "Gold" },
    { id: "rainbow", name: "Rainbow" }
  ];

  const DEFAULTS = { template: "pop", size: 5, pos: 14, upper: false };
  const STORE_KEY = "captionflow-style";

  const state = { ...DEFAULTS, chunks: [] };
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
    if (saved && TEMPLATES.some((t) => t.id === saved.template)) {
      Object.assign(state, {
        template: saved.template,
        size: Number(saved.size) || DEFAULTS.size,
        pos: Number.isFinite(Number(saved.pos)) ? Number(saved.pos) : DEFAULTS.pos,
        upper: Boolean(saved.upper)
      });
    }
  } catch {
    /* storage unavailable – use defaults */
  }

  function save() {
    try {
      const { template, size, pos, upper } = state;
      localStorage.setItem(STORE_KEY, JSON.stringify({ template, size, pos, upper }));
    } catch {
      /* ignore */
    }
  }

  /* ---------- Wrap the video in a stage and add the overlay ---------- */
  const stage = document.createElement("div");
  stage.className = "video-stage";
  video.parentNode.insertBefore(stage, video);
  stage.append(video);

  const overlay = document.createElement("div");
  overlay.className = "cap-overlay";
  const textEl = document.createElement("span");
  overlay.append(textEl);
  stage.append(overlay);

  const fsBtn = document.createElement("button");
  fsBtn.type = "button";
  fsBtn.className = "cap-fs";
  fsBtn.textContent = "⛶";
  fsBtn.title = "Fullscreen with captions";
  fsBtn.setAttribute("aria-label", "Fullscreen with captions");
  fsBtn.hidden = true;
  fsBtn.addEventListener("click", () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else if (stage.requestFullscreen) stage.requestFullscreen();
  });
  stage.append(fsBtn);

  video.addEventListener("loadedmetadata", () => {
    fsBtn.hidden = false;
    applyStyle();
  });

  /* ---------- Build the style panel ---------- */
  const panel = document.createElement("section");
  panel.className = "style-panel";
  panel.innerHTML = `
    <div class="style-title">🎨 Caption style</div>
    <div class="tpl-grid" role="group" aria-label="Caption templates"></div>
    <div class="style-controls">
      <label>Text size
        <input type="range" id="capSize" min="2.5" max="9" step="0.1">
      </label>
      <label>Vertical position
        <input type="range" id="capPos" min="3" max="80" step="1">
      </label>
      <label class="check"><input type="checkbox" id="capUpper"> UPPERCASE</label>
      <div class="style-actions">
        <button type="button" class="btn primary" id="capAuto">✨ Auto adjust</button>
        <button type="button" class="btn secondary" id="capReset">Reset</button>
      </div>
    </div>
    <p class="muted style-hint">
      Pick a template to preview it on your video. After generating captions, click any
      caption line to edit it, and click a time to jump there.
    </p>`;
  output.parentNode.insertBefore(panel, output);

  const grid = panel.querySelector(".tpl-grid");
  const sizeInput = panel.querySelector("#capSize");
  const posInput = panel.querySelector("#capPos");
  const upperInput = panel.querySelector("#capUpper");

  TEMPLATES.forEach((t) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "tpl-btn";
    btn.dataset.template = t.id;
    btn.setAttribute("aria-pressed", "false");

    const sample = document.createElement("span");
    sample.className = "cap-text cap-t-" + t.id;
    sample.textContent = "Aa";

    const label = document.createElement("small");
    label.textContent = t.name;

    btn.append(sample, label);
    btn.addEventListener("click", () => {
      state.template = t.id;
      applyStyle();
      save();
    });
    grid.append(btn);
  });

  /* ---------- Apply current style ---------- */
  function applyStyle() {
    textEl.className = "cap-text cap-t-" + state.template;
    stage.classList.toggle("caps-upper", state.upper);

    const width = video.clientWidth || stage.clientWidth || 320;
    const px = Math.max(10, (width * state.size) / 100);
    stage.style.setProperty("--cap-size", px + "px");
    stage.style.setProperty("--cap-bottom", state.pos + "%");

    grid.querySelectorAll(".tpl-btn").forEach((b) => {
      const active = b.dataset.template === state.template;
      b.classList.toggle("active", active);
      b.setAttribute("aria-pressed", String(active));
    });

    sizeInput.value = state.size;
    posInput.value = state.pos;
    upperInput.checked = state.upper;
  }

  sizeInput.addEventListener("input", () => {
    state.size = Number(sizeInput.value);
    applyStyle();
    save();
  });
  posInput.addEventListener("input", () => {
    state.pos = Number(posInput.value);
    applyStyle();
    save();
  });
  upperInput.addEventListener("change", () => {
    state.upper = upperInput.checked;
    applyStyle();
    save();
  });

  /* Auto adjust: pick a size so typical lines fit in about two lines,
     and move captions higher on tall (phone) videos. */
  function autoAdjust() {
    if (!state.chunks.length) return;

    const lengths = state.chunks
      .map((c) => c.text.trim().length)
      .filter(Boolean)
      .sort((a, b) => a - b);
    const typical = lengths[Math.floor(lengths.length * 0.8)] || 30;

    // ~0.68em average glyph width (bold text), 88% usable width, aiming for 2 lines
    const size = (88 * 2) / (0.68 * typical);
    state.size = Math.round(Math.min(6.5, Math.max(3, size)) * 10) / 10;

    const portrait = video.videoHeight > video.videoWidth;
    state.pos = portrait ? 22 : 14;

    applyStyle();
    save();
  }

  panel.querySelector("#capAuto").addEventListener("click", () => {
    autoAdjust();
    if (typeof notify === "function") notify("Captions auto-adjusted!");
  });

  panel.querySelector("#capReset").addEventListener("click", () => {
    Object.assign(state, DEFAULTS);
    applyStyle();
    save();
    if (typeof notify === "function") notify("Style reset.");
  });

  /* ---------- Keep font size in step with the video width ---------- */
  if ("ResizeObserver" in window) {
    new ResizeObserver(() => applyStyle()).observe(video);
  }
  document.addEventListener("fullscreenchange", () => setTimeout(applyStyle, 50));

  /* ---------- Sync the caption with the video time ---------- */
  let raf = 0;

  function currentText() {
    const t = video.currentTime;
    for (let i = 0; i < state.chunks.length; i++) {
      const c = state.chunks[i];
      const start = c.timestamp?.[0] ?? 0;
      const end = c.timestamp?.[1] ?? start + 3;
      if (t >= start && t < end) return c.text.trim();
    }
    return "";
  }

  const SAMPLE = "Your captions will look like this ✨";

  function update() {
    // Before captions are generated, show a sample so you can try templates
    const text = state.chunks.length ? currentText() : SAMPLE;
    if (textEl.textContent !== text) textEl.textContent = text;
  }

  function loop() {
    update();
    if (!video.paused && !video.ended) raf = requestAnimationFrame(loop);
  }

  video.addEventListener("play", () => {
    cancelAnimationFrame(raf);
    loop();
  });
  ["pause", "seeked", "timeupdate", "loadeddata", "ended"].forEach((evt) =>
    video.addEventListener(evt, update)
  );

  /* ---------- Hooks from script.js ---------- */
  window.onCaptionsReady = (chunks) => {
    state.chunks = chunks;
    autoAdjust(); // the "auto edit": fit size/position to this video and text

    // Make each caption line editable and clickable
    output.querySelectorAll(".caption-line").forEach((line, i) => {
      const time = line.querySelector("time");
      const span = line.querySelector("span");
      if (!chunks[i] || !span || !time) return;

      span.contentEditable = "true";
      span.spellcheck = false;
      span.addEventListener("input", () => {
        chunks[i].text = span.textContent;
        update();
      });
      span.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          span.blur();
        }
      });

      time.title = "Jump to this caption";
      time.addEventListener("click", () => {
        video.currentTime = chunks[i].timestamp?.[0] ?? 0;
        update();
      });
    });

    update();
  };

  // New video chosen → clear old captions and hide the panel
  if (fileInput) {
    fileInput.addEventListener("change", () => {
      if (!fileInput.files[0]) return;
      state.chunks = [];
      update();
      fsBtn.hidden = true;
    });
  }

  applyStyle();
  update();
})();

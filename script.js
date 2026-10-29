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
  track.addEventListener("load", () => {
    track.track.mode = "showing";
  });
  track.track.mode = "showing";
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

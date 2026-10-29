
const $ = (id) => document.getElementById(id);

const videoFileInput = $("videoFile");
const videoPreview = $("videoPreview");
const videoFileName = $("videoFileName");

let currentVideoUrl = null;

if (videoFileInput && videoPreview && videoFileName) {
  videoFileInput.addEventListener("change", () => {
    const file = videoFileInput.files[0];

    if (!file) return;

    if (!file.type.startsWith("video/")) {
      notify("Please select a video file.");
      videoFileInput.value = "";
      return;
    }

    if (currentVideoUrl) {
      URL.revokeObjectURL(currentVideoUrl);
    }

    currentVideoUrl = URL.createObjectURL(file);

    videoPreview.src = currentVideoUrl;
    videoPreview.hidden = false;
    videoFileName.textContent = file.name;

    notify("Video loaded! You can preview it now.");
  });
}


let mode = "caption";
let platform = "YouTube";
let tone = "Professional";

let lastResults = {
  captions: [],
  hooks: [],
  tags: []
};

let history = [];
let toastTimer;

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

// Notifications
function notify(message) {
  $("toast").textContent = message;
  $("toast").classList.remove("hidden");

  clearTimeout(toastTimer);

  toastTimer = setTimeout(() => {
    $("toast").classList.add("hidden");
  }, 2200);
}

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
    button.setAttribute(
      "aria-label",
      `Copy ${prefix} ${index + 1}`
    );

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

  renderTextResults(
    $("captionResults"),
    lastResults.captions,
    "caption"
  );

  renderTextResults(
    $("hookResults"),
    lastResults.hooks,
    "hook"
  );

  renderTags(lastResults.tags);

  history.unshift({
    topic,
    captions: [...lastResults.captions],
    hooks: [...lastResults.hooks],
    tags: [...lastResults.tags]
  });

  history = history.slice(0, 20);

  notify("Your content ideas are ready!");

  const target =
    mode === "hook"
      ? $("hookResults")
      : mode === "hashtags"
        ? $("tagResults")
        : $("captionResults");

  if (window.matchMedia("(max-width: 700px)").matches) {
    target.scrollIntoView({
      behavior: "smooth",
      block: "center"
    });
  }
}

$("generate").addEventListener("click", generate);

// Copy text to clipboard
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

    notify(
      success
        ? "Copied to clipboard!"
        : "Copy failed. Please select the text."
    );
  }
}

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

  $("count").textContent =
    $("topic").value.length + "/200";

  generate();
});

// Navigation
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
    if (!history.length) {
      notify("Your history will appear after your first generation.");
      return;
    }

    const item = history[0];

    $("topic").value = item.topic;
    $("count").textContent = item.topic.length + "/200";

    lastResults = {
      captions: [...item.captions],
      hooks: [...item.hooks],
      tags: [...item.tags]
    };

    renderTextResults(
      $("captionResults"),
      item.captions,
      "caption"
    );

    renderTextResults(
      $("hookResults"),
      item.hooks,
      "hook"
    );

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
  button.addEventListener("click", () => {
    setPage(button.dataset.page);
  });
});

// Time-based greeting
const hour = new Date().getHours();

$("greeting").textContent =
  (hour < 12
    ? "Good morning"
    : hour < 18
      ? "Good afternoon"
      : "Good evening") + ", Creator ✨";

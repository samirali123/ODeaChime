"use strict";

const log = document.getElementById("log");
const form = document.getElementById("composer");
const input = document.getElementById("input");
const sendBtn = document.getElementById("send");
const photo = document.getElementById("photo");
const preview = document.getElementById("preview");
const previewImg = document.getElementById("preview-img");

let conversationId = null;
let attached = null; // { mediaType, data, url }

const MAX_EDGE = 1600; // shrink big phone photos before upload

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Text with bare URLs turned into links. Never injects HTML. */
function linkify(text) {
  const frag = document.createDocumentFragment();
  const re = /https?:\/\/[^\s)<>\]]+/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    frag.append(text.slice(last, m.index));
    const url = m[0].replace(/[.,;:!?]+$/, "");
    const a = el("a", "", url);
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    frag.append(a);
    last = m.index + url.length;
  }
  frag.append(text.slice(last));
  return frag;
}

function addMessage(kind, text, imageUrl) {
  document.getElementById("welcome")?.remove();
  const msg = el("div", `msg ${kind}`);
  if (imageUrl) {
    const img = el("img");
    img.src = imageUrl;
    img.alt = "Your photo";
    msg.append(img);
  }
  if (text) msg.append(kind === "bot" ? linkify(text) : text);
  log.append(msg);
  log.scrollTop = log.scrollHeight;
  return msg;
}

async function shrink(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const url = canvas.toDataURL("image/jpeg", 0.85);
  return { mediaType: "image/jpeg", data: url.split(",")[1], url };
}

photo.addEventListener("change", async () => {
  const file = photo.files?.[0];
  if (!file) return;
  try {
    attached = await shrink(file);
    previewImg.src = attached.url;
    preview.hidden = false;
  } catch {
    addMessage("error", "Couldn't read that photo.");
  }
  photo.value = "";
});

document.getElementById("remove-photo").addEventListener("click", () => {
  attached = null;
  preview.hidden = true;
});

document.getElementById("new-chat").addEventListener("click", () => {
  conversationId = null;
  log.replaceChildren();
  addMessage("bot", "New chat started. What would you like to know?");
});

for (const chip of document.querySelectorAll(".chip")) {
  chip.addEventListener("click", () => {
    input.value = chip.textContent;
    form.requestSubmit();
  });
}

input.addEventListener("input", () => {
  input.style.height = "auto";
  input.style.height = `${input.scrollHeight}px`;
});
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    form.requestSubmit();
  }
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const message = input.value.trim();
  if (!message && !attached) return;

  const image = attached;
  addMessage("user", message, image?.url);
  input.value = "";
  input.style.height = "auto";
  attached = null;
  preview.hidden = true;
  sendBtn.disabled = true;
  const typing = addMessage("bot typing", "Thinking…");

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        conversationId,
        message,
        image: image ? { mediaType: image.mediaType, data: image.data } : undefined,
      }),
    });
    const body = await res.json().catch(() => ({}));
    typing.remove();
    if (!res.ok) {
      addMessage("error", body.error || `Something went wrong (${res.status}).`);
      if (res.status === 400 && /new chat/i.test(body.error || "")) conversationId = null;
      return;
    }
    conversationId = body.conversationId;
    addMessage("bot", body.reply);
  } catch {
    typing.remove();
    addMessage("error", "Couldn't reach the assistant. Check your connection.");
  } finally {
    sendBtn.disabled = false;
    input.focus();
  }
});

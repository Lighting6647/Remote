const elements = {
  server: document.querySelector("#server"), sessionId: document.querySelector("#sessionId"),
  joinToken: document.querySelector("#joinToken"), connect: document.querySelector("#connect"),
  disconnect: document.querySelector("#disconnect"), video: document.querySelector("#remoteScreen"),
  placeholder: document.querySelector("#placeholder"), status: document.querySelector("#status"),
  dot: document.querySelector("#dot"), log: document.querySelector("#log"),
  tools: document.querySelector(".tools"), clipboardSyncStatus: document.querySelector("#clipboardSyncStatus"),
  file: document.querySelector("#file"),
  capabilities: document.querySelector("#capabilities"), fullscreen: document.querySelector("#fullscreen"),
  viewer: document.querySelector(".viewer"), modeBadge: document.querySelector("#modeBadge"),
  showDesktop: document.querySelector("#showDesktop"), turnServer: document.querySelector("#turnServer"),
  turnUsername: document.querySelector("#turnUsername"), turnPassword: document.querySelector("#turnPassword"),
  forceRelay: document.querySelector("#forceRelay"), deviceName: document.querySelector("#deviceName"),
  saveDevice: document.querySelector("#saveDevice"), deleteDevice: document.querySelector("#deleteDevice"),
  savedDevices: document.querySelector("#savedDevices"), autoReconnect: document.querySelector("#autoReconnect"),
  clearLog: document.querySelector("#clearLog")
};

let socket;
let peer;
let offerCreated = false;
let controlChannel;
let inputChannel;
let fileChannel;
let capabilities = { control: false, clipboard: false, files: false, platform: "unknown" };
let keyboardCapture = false;
const pendingIceCandidates = [];
let statsTimer;
let reconnectTimer;
let reconnectAttempts = 0;
let clipboardTimer;
let clipboardSyncBusy = false;
let clipboardInitializing = false;
let clipboardRequestPending = false;
let clipboardRequestId = 0;
let clipboardGeneration = 0;
let lastLocalClipboard;
let lastRemoteClipboard;
let relayAvailable = false;
let signalingTimer;
let iceTimer;
const pendingFileTransfers = new Map();

function normalizedDeviceId() { return elements.sessionId.value.replace(/\D/g, "").slice(0, 9); }

function loadAddressBook() {
  const devices = JSON.parse(localStorage.getItem("remote-address-book") || "[]");
  elements.savedDevices.replaceChildren(Object.assign(document.createElement("option"), { value: "", textContent: "— เลือกเครื่อง —" }), ...devices.map((device) => Object.assign(document.createElement("option"), { value: device.id, textContent: `${device.name} · ${device.id.replace(/(\d{3})(?=\d)/g, "$1 ")}` })));
}

function saveCurrentDevice() {
  const id = normalizedDeviceId(); const name = elements.deviceName.value.trim();
  if (!/^\d{9}$/.test(id) || !name) { log("กรอกรหัสเครื่อง 9 หลักและชื่อเครื่องก่อนบันทึก"); return; }
  const devices = JSON.parse(localStorage.getItem("remote-address-book") || "[]").filter((device) => device.id !== id);
  devices.unshift({ id, name }); localStorage.setItem("remote-address-book", JSON.stringify(devices.slice(0, 50))); loadAddressBook(); log(`บันทึก ${name} แล้ว`);
}

function deleteCurrentDevice() {
  const selectedId = elements.savedDevices.value;
  if (!selectedId) { log("กรุณาเลือกเครื่องที่ต้องการลบจากรายการ"); return; }
  const devices = JSON.parse(localStorage.getItem("remote-address-book") || "[]").filter((device) => device.id !== selectedId);
  localStorage.setItem("remote-address-book", JSON.stringify(devices));
  loadAddressBook();
  log(`ลบเครื่องรหัส ${selectedId.replace(/(\d{3})(?=\d)/g, "$1 ")} ออกจากสมุดรายชื่อแล้ว`);
}

function rtcConfiguration(managedIceServers) {
  const turnUrl = elements.turnServer.value.trim();
  const fallback = [{ urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] }];
  const source = Array.isArray(managedIceServers) && managedIceServers.length ? managedIceServers : fallback;
  const iceServers = source.map((server) => {
    const urls = Array.isArray(server.urls) ? [...server.urls] : [server.urls];
    urls.sort((left, right) => iceUrlPriority(left) - iceUrlPriority(right));
    return { ...server, urls };
  });
  if (turnUrl) {
    const urls = turnUrl.includes("?transport=") ? [turnUrl] : [turnUrl, `${turnUrl}?transport=tcp`];
    iceServers.push({ urls, username: elements.turnUsername.value, credential: elements.turnPassword.value });
  }
  return { iceServers, iceTransportPolicy: elements.forceRelay.checked ? "relay" : "all", iceCandidatePoolSize: 0 };
}

function iceUrlPriority(url) {
  if (/^turns:.*:443(?:\?|$)/i.test(url)) return 0;
  if (/^turn:.*:80(?:\?|$)/i.test(url)) return 1;
  if (/^turns:/i.test(url)) return 2;
  if (/transport=tcp/i.test(url)) return 3;
  if (/^turn:/i.test(url)) return 4;
  return 5;
}

function applyNetworkConfiguration(message) {
  const manualRelay = Boolean(elements.turnServer.value.trim());
  relayAvailable = manualRelay || message.relayAvailable === true;
  peer.setConfiguration(rtcConfiguration(message.iceServers));
  if (elements.forceRelay.checked && !relayAvailable) throw new Error("Signaling ยังไม่มี TURN relay — ไม่สามารถบังคับ Relay ได้");
  log(relayAvailable ? "ได้รับ TURN credential แบบชั่วคราวแล้ว" : "ไม่มี TURN relay; จะลองเชื่อมต่อแบบ P2P");
}

async function addRemoteCandidate(candidate) {
  if (peer?.remoteDescription) await peer.addIceCandidate(candidate);
  else pendingIceCandidates.push(candidate);
}

async function flushRemoteCandidates() {
  while (pendingIceCandidates.length) await peer.addIceCandidate(pendingIceCandidates.shift());
}

async function reportConnectionStats() {
  if (!peer || peer.connectionState !== "connected") return;
  const reports = await peer.getStats();
  let pair;
  reports.forEach((report) => { if (report.type === "candidate-pair" && report.state === "succeeded" && report.nominated) pair = report; });
  if (!pair) return;
  const remote = reports.get(pair.remoteCandidateId);
  const route = remote?.candidateType === "relay" ? "TURN relay" : remote?.candidateType === "srflx" ? "Internet P2P" : "เครือข่ายตรง";
  const latency = Number.isFinite(pair.currentRoundTripTime) ? ` · ${Math.round(pair.currentRoundTripTime * 1000)} ms` : "";
  setStatus(`เชื่อมต่อแล้ว · ${route}${latency}`, true);
}

function log(text) {
  const time = new Date().toLocaleTimeString();
  elements.log.textContent = `[${time}] ${text}\n${elements.log.textContent}`.slice(0, 1800);
}

function setStatus(text, live = false) {
  elements.status.textContent = text;
  elements.dot.classList.toggle("live", live);
}

function send(message) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function sendControl(message) {
  if (controlChannel?.readyState === "open") controlChannel.send(JSON.stringify(message));
}

async function sendControlQueued(message) {
  while (controlChannel?.readyState === "open" && controlChannel.bufferedAmount > 512_000) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  sendControl(message);
}

function sendRealtimeInput(event) {
  if (inputChannel?.readyState === "open" && inputChannel.bufferedAmount < 1_024) inputChannel.send(JSON.stringify({ kind: "input", event }));
}

function setClipboardSyncStatus(text, live = false) {
  elements.clipboardSyncStatus.textContent = `คลิปบอร์ด Auto Sync: ${text}`;
  elements.clipboardSyncStatus.classList.toggle("live", live);
}

function requestRemoteClipboard() {
  if (clipboardRequestPending || controlChannel?.readyState !== "open") return;
  clipboardRequestPending = true;
  const requestId = ++clipboardRequestId;
  sendControl({ kind: "clipboard-get", requestId, generation: clipboardGeneration });
  setTimeout(() => { if (requestId === clipboardRequestId) clipboardRequestPending = false; }, 1500);
}

async function clipboardTick() {
  if (clipboardSyncBusy || !capabilities.clipboard || controlChannel?.readyState !== "open") return;
  clipboardSyncBusy = true;
  try {
    const text = String(await window.remoteController.clipboardRead()).slice(0, 1_000_000);
    if (!clipboardInitializing && lastLocalClipboard !== undefined && text !== lastLocalClipboard) {
      clipboardGeneration += 1;
      lastLocalClipboard = text;
      lastRemoteClipboard = text;
      sendControl({ kind: "clipboard-set", text });
      log("ซิงก์คลิปบอร์ดไป Agent อัตโนมัติ");
    } else if (lastLocalClipboard === undefined) lastLocalClipboard = text;
    requestRemoteClipboard();
  } catch (error) {
    setClipboardSyncStatus("ผิดพลาด");
    log(`CLIPBOARD ERROR: ${error instanceof Error ? error.message : String(error)}`);
  } finally { clipboardSyncBusy = false; }
}

async function applyRemoteClipboard(message) {
  clipboardRequestPending = false;
  const text = String(message.text ?? "").slice(0, 1_000_000);
  if (clipboardInitializing) {
    lastRemoteClipboard = text;
    clipboardInitializing = false;
    setClipboardSyncStatus("ทำงานอัตโนมัติ", true);
    return;
  }
  if (Number.isFinite(message.generation) && message.generation !== clipboardGeneration) return;
  if (text === lastRemoteClipboard) return;
  await window.remoteController.clipboardWrite(text);
  lastRemoteClipboard = text;
  lastLocalClipboard = text;
  log("รับคลิปบอร์ดจาก Agent อัตโนมัติ");
}

async function startClipboardSync() {
  if (clipboardTimer) return;
  clipboardInitializing = true;
  clipboardRequestPending = false;
  clipboardGeneration = 0;
  lastRemoteClipboard = undefined;
  lastLocalClipboard = String(await window.remoteController.clipboardRead()).slice(0, 1_000_000);
  setClipboardSyncStatus("กำลังเริ่ม…");
  requestRemoteClipboard();
  clipboardTimer = setInterval(clipboardTick, 700);
}

function stopClipboardSync() {
  clearInterval(clipboardTimer);
  clipboardTimer = undefined;
  clipboardSyncBusy = false;
  clipboardInitializing = false;
  clipboardRequestPending = false;
  lastLocalClipboard = undefined;
  lastRemoteClipboard = undefined;
  setClipboardSyncStatus("ไม่ได้รับอนุญาต");
}

function updateCapabilities(value) {
  capabilities = value;
  elements.capabilities.textContent = `สิทธิ์: ควบคุม ${value.control ? "✓" : "–"} · คลิปบอร์ด ${value.clipboard ? "✓" : "–"} · ไฟล์ ${value.files ? "✓" : "–"} · Admin ${value.adminMode ? "✓" : "–"}`;
  elements.video.classList.toggle("control", value.control);
  elements.modeBadge.textContent = value.control ? "CONTROL ENABLED" : "VIEW ONLY";
  elements.modeBadge.classList.toggle("control", value.control);
  if (value.clipboard) startClipboardSync().catch((error) => { setClipboardSyncStatus("เริ่มไม่ได้"); log(`CLIPBOARD ERROR: ${error.message}`); });
  else stopClipboardSync();
  elements.file.disabled = !value.files;
}

function attachControlChannel(channel) {
  controlChannel = channel;
  channel.onopen = () => { elements.tools.hidden = false; log("ช่องควบคุมพร้อมใช้งาน"); };
  channel.onmessage = async ({ data }) => {
    const message = JSON.parse(data);
    if (message.kind === "capabilities") updateCapabilities(message);
    if (message.kind === "clipboard-value") await applyRemoteClipboard(message);
    if (message.kind === "input-error") { setStatus(`Agent ปฏิเสธ input: ${message.message}`); log(`INPUT ERROR: ${message.message}`); }
  };
  channel.onclose = () => { controlChannel = undefined; stopClipboardSync(); };
}

function attachInputChannel(channel) {
  inputChannel = channel;
  channel.onopen = () => log("ช่องเมาส์ความหน่วงต่ำพร้อมใช้งาน");
  channel.onclose = () => { inputChannel = undefined; };
}

function attachFileChannel(channel) {
  fileChannel = channel;
  channel.binaryType = "arraybuffer";
  channel.bufferedAmountLowThreshold = 256_000;
  channel.onopen = () => log("ช่องส่งไฟล์พร้อมใช้งาน");
  channel.onmessage = ({ data }) => {
    if (typeof data !== "string") return;
    const message = JSON.parse(data);
    if (message.kind === "file-error") {
      log(`FILE ERROR: ${message.message}`);
      const transfer = pendingFileTransfers.get(message.id); pendingFileTransfers.delete(message.id);
      transfer?.reject(new Error(message.message));
    }
    if (message.kind === "file-complete") {
      const transfer = pendingFileTransfers.get(message.id); pendingFileTransfers.delete(message.id);
      transfer?.resolve(message);
    }
    if (message.kind === "file-verified") log(`Agent ตรวจ SHA-256 ผ่าน (${message.bytes} bytes)`);
  };
  channel.onclose = () => {
    fileChannel = undefined;
    for (const transfer of pendingFileTransfers.values()) transfer.reject(new Error("ช่องส่งไฟล์ถูกตัด"));
    pendingFileTransfers.clear();
  };
}

async function createOffer() {
  if (offerCreated || !peer) return;
  offerCreated = true;
  const offer = await peer.createOffer({ offerToReceiveVideo: true, offerToReceiveAudio: false });
  await peer.setLocalDescription(offer);
  send({ type: "offer", sdp: offer.sdp });
  log("ส่ง WebRTC offer แล้ว");
  clearTimeout(iceTimer);
  iceTimer = setTimeout(() => disconnect(relayAvailable ? "WebRTC ใช้เวลานานเกินไป — ตรวจ Firewall/TURN" : "เชื่อมต่อข้ามเครือข่ายไม่ได้ — Signaling ยังไม่มี TURN relay", true), 30_000);
}

function connect() {
  clearTimeout(reconnectTimer);
  const deviceId = normalizedDeviceId(); const password = elements.joinToken.value.replace(/\D/g, "").slice(0, 6);
  if (!elements.server.value || !/^\d{9}$/.test(deviceId) || !/^\d{6}$/.test(password)) {
    setStatus("กรอกรหัสเครื่อง 9 หลักและรหัสผ่าน 6 หลัก"); return;
  }
  elements.connect.disabled = true;
  setStatus("กำลังเชื่อมต่อ signaling…");
  peer = new RTCPeerConnection(rtcConfiguration());
  const videoTransceiver = peer.addTransceiver("video", { direction: "recvonly" });
  const codecs = RTCRtpReceiver.getCapabilities?.("video")?.codecs?.filter((codec) => /VP8|H264/i.test(codec.mimeType));
  if (codecs?.length) videoTransceiver.setCodecPreferences(codecs);
  attachControlChannel(peer.createDataChannel("control", { ordered: true }));
  attachInputChannel(peer.createDataChannel("input", { ordered: false, maxRetransmits: 0 }));
  attachFileChannel(peer.createDataChannel("file-transfer", { ordered: true }));
  peer.onicecandidate = ({ candidate }) => { if (candidate) send({ type: "ice-candidate", candidate }); };
  peer.onicecandidateerror = ({ errorCode, errorText, url }) => {
    if (errorCode === 701) return;
    let protocol = "ICE";
    try { protocol = new URL(url).protocol.replace(":", "").toUpperCase(); } catch {}
    log(`${protocol} ERROR ${errorCode}: ${errorText}`);
  };
  peer.onicegatheringstatechange = () => log(`ICE gathering: ${peer.iceGatheringState}`);
  peer.ontrack = ({ streams }) => {
    elements.video.srcObject = streams[0];
    elements.video.play().catch(() => log("กดภายในหน้าจอเพื่อเริ่มแสดงภาพ"));
    elements.placeholder.hidden = true;
    setStatus("กำลังรับภาพหน้าจอ", true);
    log("ได้รับ video stream");
  };
  peer.onconnectionstatechange = () => {
    log(`WebRTC ${peer.connectionState}`);
    if (peer.connectionState === "connected") { clearTimeout(iceTimer); clearInterval(statsTimer); statsTimer = setInterval(reportConnectionStats, 3000); reportConnectionStats(); }
    if (["failed", "closed", "disconnected"].includes(peer.connectionState)) setStatus(`WebRTC: ${peer.connectionState}`);
  };

  socket = new WebSocket(elements.server.value);
  signalingTimer = setTimeout(() => { if (peer) disconnect("Signaling ไม่ตอบสนองภายใน 60 วินาที", true); }, 60_000);
  socket.addEventListener("open", () => {
    clearTimeout(signalingTimer);
    send({ type: "hello", sessionId: deviceId, joinToken: password, role: "controller" });
    reconnectAttempts = 0;
    setStatus("รอ Agent ยืนยัน…", true);
    elements.disconnect.hidden = false;
    log("เชื่อมต่อ signaling แล้ว");
  });
  socket.addEventListener("message", async ({ data }) => {
    const message = JSON.parse(data);
    if (message.type === "peer-ready") {
      try { applyNetworkConfiguration(message); await createOffer(); }
      catch (error) { disconnect(error instanceof Error ? error.message : String(error)); }
    }
    if (message.type === "error") { disconnect(`Signaling: ${message.message}`, message.retryable === true); return; }
    if (message.type === "answer") { await peer.setRemoteDescription({ type: "answer", sdp: message.sdp }); await flushRemoteCandidates(); log("รับ WebRTC answer แล้ว"); }
    if (message.type === "ice-candidate") await addRemoteCandidate(message.candidate);
    if (message.type === "end") disconnect("Agent สิ้นสุด session");
  });
  socket.addEventListener("error", () => { if (peer) disconnect("เชื่อมต่อ signaling ไม่สำเร็จ", true); });
  socket.addEventListener("close", (event) => { if (peer) disconnect(`การเชื่อมต่อสิ้นสุด (${event.code})`, true); });
}

function disconnect(reason = "ตัดการเชื่อมต่อแล้ว", retry = false) {
  keyboardCapture = false;
  clearInterval(statsTimer); statsTimer = undefined; clearTimeout(signalingTimer); signalingTimer = undefined; clearTimeout(iceTimer); iceTimer = undefined; pendingIceCandidates.length = 0; relayAvailable = false;
  if (socket?.readyState === WebSocket.OPEN) send({ type: "end", reason: "controller-disconnected" });
  socket?.close(); socket = undefined;
  peer?.close(); peer = undefined; offerCreated = false;
  controlChannel?.close(); controlChannel = undefined;
  inputChannel?.close(); inputChannel = undefined;
  fileChannel?.close(); fileChannel = undefined;
  elements.video.srcObject = null; elements.placeholder.hidden = false;
  elements.disconnect.hidden = true; elements.tools.hidden = true; elements.connect.disabled = false;
  updateCapabilities({ control: false, clipboard: false, files: false, platform: "unknown" });
  setStatus(reason); log(reason);
  if (retry && elements.autoReconnect.checked) {
    reconnectAttempts += 1; const delay = Math.min(15_000, 1000 * (2 ** Math.min(reconnectAttempts, 4)));
    setStatus(`สัญญาณหลุด · ลองใหม่ใน ${Math.ceil(delay / 1000)} วินาที`);
    reconnectTimer = setTimeout(connect, delay);
  }
}

elements.connect.addEventListener("click", connect);
elements.disconnect.addEventListener("click", () => disconnect());
elements.saveDevice.addEventListener("click", saveCurrentDevice);
elements.deleteDevice.addEventListener("click", deleteCurrentDevice);
elements.clearLog.addEventListener("click", () => { elements.log.textContent = ""; });
elements.savedDevices.addEventListener("change", () => {
  if (!elements.savedDevices.value) return;
  elements.sessionId.value = elements.savedDevices.value.replace(/(\d{3})(?=\d)/g, "$1 ");
});
elements.sessionId.addEventListener("input", () => {
  const id = normalizedDeviceId(); elements.sessionId.value = id.replace(/(\d{3})(?=\d)/g, "$1 ");
});
elements.video.tabIndex = 0;
let pendingMove;
let moveTimer;
let inputSequence = 0;
function sequencedInput(event) { return { ...event, seq: ++inputSequence }; }
function screenPosition(event) {
  const rect = elements.video.getBoundingClientRect();
  const sourceRatio = (elements.video.videoWidth || rect.width) / (elements.video.videoHeight || rect.height);
  const boxRatio = rect.width / rect.height;
  let left = rect.left, top = rect.top, width = rect.width, height = rect.height;
  if (boxRatio > sourceRatio) { width = height * sourceRatio; left += (rect.width - width) / 2; }
  else { height = width / sourceRatio; top += (rect.height - height) / 2; }
  if (event.clientX < left || event.clientX > left + width || event.clientY < top || event.clientY > top + height) return null;
  return { x: (event.clientX - left) / width, y: (event.clientY - top) / height };
}
elements.video.addEventListener("pointermove", (event) => {
  if (!capabilities.control) return;
  const position = screenPosition(event); if (!position) return;
  pendingMove = sequencedInput({ type: "move", ...position });
  if (!moveTimer) moveTimer = setTimeout(() => { sendRealtimeInput(pendingMove); moveTimer = undefined; }, 12);
});
function sendPointerButton(event, down) {
  if (!capabilities.control) return;
  const position = screenPosition(event);
  sendControl({ kind: "input", event: { type: "button", button: event.button, down, ...(position || {}) } });
}
elements.video.addEventListener("pointerdown", (event) => {
  elements.video.focus();
  keyboardCapture = capabilities.control;
  if (keyboardCapture) { elements.modeBadge.textContent = "CONTROL ENABLED • KEYBOARD"; log("จับคีย์บอร์ดแล้ว"); }
  elements.video.setPointerCapture(event.pointerId);
  sendPointerButton(event, true);
});
elements.video.addEventListener("pointerup", (event) => {
  if (elements.video.hasPointerCapture(event.pointerId)) elements.video.releasePointerCapture(event.pointerId);
  sendPointerButton(event, false);
});
elements.video.addEventListener("contextmenu", (event) => event.preventDefault());
elements.video.addEventListener("wheel", (event) => { if (capabilities.control) { event.preventDefault(); sendControl({ kind: "input", event: { type: "wheel", delta: event.deltaY } }); } }, { passive: false });

const codeMap = { Space: "Space", ArrowLeft: "Left", ArrowRight: "Right", ArrowUp: "Up", ArrowDown: "Down", ShiftLeft: "LeftShift", ShiftRight: "RightShift", ControlLeft: "LeftControl", ControlRight: "RightControl", AltLeft: "LeftAlt", AltRight: "RightAlt", MetaLeft: "LeftMeta", MetaRight: "RightMeta", Escape: "Escape", Backspace: "Backspace", Tab: "Tab", Enter: "Enter", Delete: "Delete", Insert: "Insert", PrintScreen: "PrintScreen", Pause: "Pause", ContextMenu: "ContextMenu", NumLock: "NumLock", ScrollLock: "ScrollLock", Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown", CapsLock: "CapsLock", Comma: "Comma", Period: "Period", Slash: "Slash", Backslash: "Backslash", Semicolon: "Semicolon", Quote: "Quote", BracketLeft: "LeftBracket", BracketRight: "RightBracket", Minus: "Minus", Equal: "Equal", Backquote: "Grave" };
function remoteKey(event) {
  if (event.code.startsWith("Key")) return event.code.slice(3);
  if (event.code.startsWith("Digit")) return `Num${event.code.slice(5)}`;
  if (/^Numpad[0-9]$/.test(event.code)) return event.code;
  if (["NumpadAdd", "NumpadSubtract", "NumpadMultiply", "NumpadDivide", "NumpadDecimal", "NumpadEnter"].includes(event.code)) return event.code;
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(event.code)) return event.code;
  return codeMap[event.code];
}
window.addEventListener("keydown", (event) => {
  if (!capabilities.control || !keyboardCapture) return;
  event.preventDefault();
  const key = remoteKey(event); if (!key) return;
  sendControl({ kind: "input", event: { type: "key", key, down: true } });
}, true);
window.addEventListener("keyup", (event) => {
  if (!capabilities.control || !keyboardCapture) return;
  event.preventDefault();
  const key = remoteKey(event); if (!key) return;
  sendControl({ kind: "input", event: { type: "key", key, down: false } });
}, true);
window.addEventListener("blur", () => {
  for (const key of ["LeftShift", "LeftControl", "LeftAlt", "LeftMeta"]) sendControl({ kind: "input", event: { type: "key", key, down: false } });
});
document.querySelector("aside").addEventListener("pointerdown", () => {
  keyboardCapture = false;
  if (capabilities.control) elements.modeBadge.textContent = "CONTROL ENABLED";
});
elements.fullscreen.addEventListener("click", async () => {
  if (document.fullscreenElement) await document.exitFullscreen(); else await elements.viewer.requestFullscreen();
});
async function keyCombo(keys) {
  for (const key of keys) sendControl({ kind: "input", event: { type: "key", key, down: true } });
  for (const key of [...keys].reverse()) sendControl({ kind: "input", event: { type: "key", key, down: false } });
}
for (const button of document.querySelectorAll("[data-shortcut]")) {
  button.addEventListener("click", () => {
    if (capabilities.control) keyCombo(button.dataset.shortcut.split(","));
  });
}
elements.showDesktop.addEventListener("click", () => {
  if (!capabilities.control) return;
  if (capabilities.platform === "win32") keyCombo(["LeftMeta", "D"]);
  else keyCombo(["LeftMeta", "F3"]);
});
async function sendFile(file) {
  if (!file || file.size > 25 * 1024 * 1024 || !capabilities.files) { log("ไฟล์ไม่ถูกต้อง ไม่มีสิทธิ์ หรือเกิน 25 MB"); return; }
  if (fileChannel?.readyState !== "open") { log("ช่องส่งไฟล์ยังไม่พร้อม"); return; }
  const id = crypto.randomUUID();
  const bytes = await file.arrayBuffer();
  const sha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((value) => value.toString(16).padStart(2, "0")).join("");
  fileChannel.send(JSON.stringify({ kind: "file-start", id, name: file.name, size: bytes.byteLength, sha256 }));
  log(`กำลังส่ง ${file.name} (${Math.ceil(file.size / 1024)} KB)`);
  for (let offset = 0; offset < bytes.byteLength; offset += 32 * 1024) {
    while (fileChannel.readyState === "open" && fileChannel.bufferedAmount > 128_000) await new Promise((resolve) => setTimeout(resolve, 10));
    if (fileChannel.readyState !== "open") throw new Error("ช่องส่งไฟล์ถูกตัด");
    fileChannel.send(bytes.slice(offset, Math.min(offset + 32 * 1024, bytes.byteLength)));
  }
  while (fileChannel.readyState === "open" && fileChannel.bufferedAmount > 0) await new Promise((resolve) => setTimeout(resolve, 10));
  if (fileChannel.readyState !== "open") throw new Error("ช่องส่งไฟล์ถูกตัด");
  const completion = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pendingFileTransfers.delete(id); reject(new Error("Agent ไม่ยืนยันการรับไฟล์ภายใน 5 นาที")); }, 300_000);
    pendingFileTransfers.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
  });
  fileChannel.send(JSON.stringify({ kind: "file-end", id }));
  log(`ส่งข้อมูล ${file.name} ครบแล้ว รอ Agent ตรวจ SHA-256 และกด Save As`);
  const result = await completion;
  log(result.saved ? `Agent บันทึก ${file.name} สำเร็จ (${result.bytes} bytes)` : `Agent ยกเลิกการบันทึก ${file.name}`);
}
elements.file.addEventListener("change", async () => { try { await sendFile(elements.file.files[0]); } catch (error) { log(`FILE ERROR: ${error instanceof Error ? error.message : String(error)}`); } finally { elements.file.value = ""; } });
elements.viewer.addEventListener("dragenter", (event) => { event.preventDefault(); log("ตรวจพบไฟล์ที่ลากเข้ามา"); if (capabilities.files) elements.viewer.classList.add("dragging"); });
elements.viewer.addEventListener("dragover", (event) => { event.preventDefault(); });
elements.viewer.addEventListener("dragleave", (event) => { if (!elements.viewer.contains(event.relatedTarget)) elements.viewer.classList.remove("dragging"); });
elements.viewer.addEventListener("drop", async (event) => {
  event.preventDefault(); elements.viewer.classList.remove("dragging");
  for (const file of event.dataTransfer.files) {
    try { await sendFile(file); } catch (error) { log(`FILE ERROR: ${error instanceof Error ? error.message : String(error)}`); }
  }
});
if (window.gsap) {
  window.gsap.from("header", { opacity: 0, y: -18, duration: .45, ease: "power2.out" });
  window.gsap.from("aside > *", { opacity: 0, x: -18, duration: .5, stagger: .035, ease: "power2.out" });
  window.gsap.from(".viewer", { opacity: 0, scale: .985, duration: .7, ease: "power2.out" });
}
loadAddressBook();

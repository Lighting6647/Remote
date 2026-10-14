const elements = {
  server: document.querySelector("#server"), sessionId: document.querySelector("#sessionId"),
  joinToken: document.querySelector("#joinToken"), consent: document.querySelector("#consent"),
  start: document.querySelector("#start"), stop: document.querySelector("#stop"),
  preview: document.querySelector("#preview"), status: document.querySelector("#statusText"),
  dot: document.querySelector("#dot"), permission: document.querySelector("#permissionBox"),
  allowControl: document.querySelector("#allowControl"), allowClipboard: document.querySelector("#allowClipboard"),
  allowFiles: document.querySelector("#allowFiles"), turnServer: document.querySelector("#turnServer"),
  turnUsername: document.querySelector("#turnUsername"), turnPassword: document.querySelector("#turnPassword"),
  forceRelay: document.querySelector("#forceRelay"), displaySource: document.querySelector("#displaySource"),
  deviceIdText: document.querySelector("#deviceIdText"), passwordText: document.querySelector("#passwordText"),
  regenerateCode: document.querySelector("#regenerateCode"),
  copyCode: document.querySelector("#copyCode")
};

let socket;
let peer;
let stream;
let controlChannel;
let inputChannel;
let videoSender;
let qualityTimer;
let adminMode = false;
let relayAvailable = false;
let signalingTimer;
let iceTimer;
const incomingFiles = new Map();
let fileChannel;
let binaryFile;
let fileMessageQueue = Promise.resolve();
const pendingIceCandidates = [];

function randomDigits(length) {
  const values = new Uint32Array(1); crypto.getRandomValues(values);
  const minimum = 10 ** (length - 1); return String(minimum + (values[0] % (9 * minimum)));
}

function initializeIdentity() {
  let deviceId = localStorage.getItem("remote-device-id");
  if (!/^\d{9}$/.test(deviceId || "")) { deviceId = randomDigits(9); localStorage.setItem("remote-device-id", deviceId); }
  elements.sessionId.value = deviceId;
  elements.deviceIdText.textContent = deviceId.replace(/(\d{3})(?=\d)/g, "$1 ");
  regenerateAccessCode();
}

function regenerateAccessCode() {
  const value = randomDigits(6); elements.joinToken.value = value; elements.passwordText.textContent = value;
  formValid();
}

async function loadDisplays() {
  const displays = await window.remoteAgent.listDisplays();
  elements.displaySource.replaceChildren(...displays.map(({ id, name }) => Object.assign(document.createElement("option"), { value: id, textContent: name })));
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
  setStatus(relayAvailable ? "TURN relay พร้อม · รอเจ้าหน้าที่เชื่อมต่อ…" : "รอเจ้าหน้าที่เชื่อมต่อ… · ไม่มี TURN fallback", true);
}

async function addRemoteCandidate(candidate) {
  if (peer?.remoteDescription) await peer.addIceCandidate(candidate);
  else pendingIceCandidates.push(candidate);
}

async function flushRemoteCandidates() {
  while (pendingIceCandidates.length) await peer.addIceCandidate(pendingIceCandidates.shift());
}

function setStatus(text, live = false) {
  elements.status.textContent = text;
  elements.dot.classList.toggle("live", live);
}

function formValid() {
  elements.start.disabled = !(elements.consent.checked && elements.server.value && elements.sessionId.value && elements.joinToken.value);
}

for (const element of [elements.server, elements.sessionId, elements.joinToken, elements.consent]) element.addEventListener("input", formValid);

async function showPermissions() {
  const status = await window.remoteAgent.permissionStatus();
  elements.permission.textContent = window.remoteAgent.platform === "darwin"
    ? `macOS Screen Recording: ${status.screen} · Accessibility: ${status.accessibility}`
    : "Windows: พร้อมขอสิทธิ์แชร์หน้าจอเมื่อเริ่ม session";
}

function send(message) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

async function acceptOffer(sdp) {
  clearTimeout(iceTimer);
  iceTimer = setTimeout(() => stop(relayAvailable ? "WebRTC ใช้เวลานานเกินไป — ตรวจ Firewall/TURN" : "เชื่อมต่อข้ามเครือข่ายไม่ได้ — Signaling ยังไม่มี TURN relay"), 30_000);
  await peer.setRemoteDescription({ type: "offer", sdp });
  await flushRemoteCandidates();
  const answer = await peer.createAnswer();
  await peer.setLocalDescription(answer);
  send({ type: "answer", sdp: answer.sdp });
}

let latestMoveSequence = 0;
function queueInput(event) {
  if (event?.type !== "move") return window.remoteAgent.input(event);
  const sequence = Number(event.seq);
  if (Number.isFinite(sequence) && sequence <= latestMoveSequence) return Promise.resolve();
  if (Number.isFinite(sequence)) latestMoveSequence = sequence;
  window.remoteAgent.inputRealtime(event);
  return Promise.resolve();
}
async function adaptVideoQuality() {
  if (!videoSender) return;
  const stats = await videoSender.getStats(); let loss = 0; let rtt = 0;
  stats.forEach((report) => { if (report.type === "remote-inbound-rtp" && report.kind === "video") { loss = report.fractionLost || 0; rtt = report.roundTripTime || 0; } });
  const target = loss > .08 || rtt > .4 ? 1_200_000 : loss > .03 || rtt > .2 ? 2_000_000 : 3_500_000;
  const parameters = videoSender.getParameters(); parameters.encodings ??= [{}]; if (!parameters.encodings.length) parameters.encodings.push({});
  if (parameters.encodings[0].maxBitrate !== target) { parameters.encodings[0].maxBitrate = target; parameters.encodings[0].maxFramerate = target < 2_000_000 ? 20 : 30; await videoSender.setParameters(parameters); }
}

async function handleControl(message) {
  if (!message || typeof message !== "object") return;
  if (message.kind === "input" && elements.allowControl.checked) await queueInput(message.event);
  if (message.kind === "clipboard-set" && elements.allowClipboard.checked) await window.remoteAgent.clipboardWrite(message.text);
  if (message.kind === "clipboard-get" && elements.allowClipboard.checked) {
    const text = await window.remoteAgent.clipboardRead();
    controlChannel?.send(JSON.stringify({ kind: "clipboard-value", text, requestId: message.requestId, generation: message.generation }));
  }
  if (message.kind === "file-start" && elements.allowFiles.checked) {
    if (message.size > 25 * 1024 * 1024) return;
    incomingFiles.set(message.id, { name: message.name, size: message.size, chunks: [] });
  }
  if (message.kind === "file-chunk" && elements.allowFiles.checked) incomingFiles.get(message.id)?.chunks.push(message.data);
  if (message.kind === "file-end" && elements.allowFiles.checked) {
    const file = incomingFiles.get(message.id); incomingFiles.delete(message.id);
    if (!file) return;
    const base64 = file.chunks.join("");
    await window.remoteAgent.saveFile({ name: file.name, base64 });
  }
}

function attachControlChannel(channel) {
  controlChannel = channel;
  channel.onopen = () => channel.send(JSON.stringify({ kind: "capabilities", platform: window.remoteAgent.platform, adminMode, control: elements.allowControl.checked, clipboard: elements.allowClipboard.checked, files: elements.allowFiles.checked }));
  let queue = Promise.resolve();
  channel.onmessage = ({ data }) => {
    queue = queue.then(() => handleControl(JSON.parse(data))).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(`ควบคุมไม่ได้: ${message}`);
      if (channel.readyState === "open") channel.send(JSON.stringify({ kind: "input-error", message }));
    });
  };
  channel.onclose = () => { controlChannel = undefined; };
}

function attachInputChannel(channel) {
  inputChannel = channel;
  channel.onmessage = ({ data }) => {
    try { const message = JSON.parse(data); if (message.kind === "input" && elements.allowControl.checked) queueInput(message.event).catch((error) => setStatus(`ควบคุมไม่ได้: ${error instanceof Error ? error.message : String(error)}`)); }
    catch (error) { setStatus(`ควบคุมไม่ได้: ${error instanceof Error ? error.message : String(error)}`); }
  };
  channel.onclose = () => { inputChannel = undefined; };
}

function attachFileChannel(channel) {
  fileChannel = channel;
  channel.binaryType = "arraybuffer";
  channel.onmessage = ({ data }) => {
    fileMessageQueue = fileMessageQueue.then(() => handleFileMessage(channel, data)).catch((error) => {
      const id = binaryFile?.id;
      if (binaryFile?.endTimer) clearTimeout(binaryFile.endTimer);
      binaryFile = undefined;
      const message = error instanceof Error ? error.message : String(error);
      setStatus(`รับไฟล์ไม่สำเร็จ: ${message}`);
      if (channel.readyState === "open") channel.send(JSON.stringify({ kind: "file-error", id, message }));
    });
  };
  channel.onclose = () => {
    if (binaryFile?.endTimer) clearTimeout(binaryFile.endTimer);
    fileChannel = undefined; binaryFile = undefined;
  };
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function receivedChunk(data) {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
  throw new Error("รูปแบบข้อมูลไฟล์ไม่รองรับ");
}

async function finishIncomingFile(channel) {
  if (!binaryFile?.ended || binaryFile.received !== binaryFile.size) return false;
  const current = binaryFile;
  if (current.endTimer) clearTimeout(current.endTimer);
  const bytes = new Uint8Array(current.received); let offset = 0;
  for (const chunk of current.chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  const hash = await sha256Hex(bytes);
  if (hash !== current.sha256) throw new Error("SHA-256 ของไฟล์ไม่ตรง");
  if (channel.readyState === "open") channel.send(JSON.stringify({ kind: "file-verified", id: current.id, bytes: current.received, sha256: hash }));
  const result = await window.remoteAgent.saveFile({ name: current.name, bytes });
  binaryFile = undefined;
  if (channel.readyState === "open") channel.send(JSON.stringify({ kind: "file-complete", id: current.id, saved: result?.saved === true, bytes: current.received, sha256: hash }));
  return true;
}

async function handleFileMessage(channel, data) {
  if (!elements.allowFiles.checked) return;
  if (typeof data !== "string") {
    if (!binaryFile) throw new Error("ได้รับข้อมูลไฟล์โดยไม่มีส่วนเริ่มต้น");
    const chunk = await receivedChunk(data);
    binaryFile.received += chunk.length;
    if (binaryFile.received > binaryFile.size) throw new Error("ขนาดไฟล์เกินข้อมูลที่แจ้ง");
    binaryFile.chunks.push(chunk);
    await finishIncomingFile(channel);
    return;
  }
  const message = JSON.parse(data);
  if (message.kind === "file-start") {
    if (binaryFile) throw new Error("มีไฟล์อื่นกำลังรับอยู่");
    const size = Number(message.size);
    if (!Number.isSafeInteger(size) || size < 0 || size > 25 * 1024 * 1024 || !/^[a-f0-9]{64}$/i.test(message.sha256 || "")) throw new Error("ข้อมูลเริ่มต้นไฟล์ไม่ถูกต้อง");
    binaryFile = { id: message.id, name: message.name, size, sha256: message.sha256.toLowerCase(), received: 0, chunks: [], ended: false, endTimer: undefined };
    return;
  }
  if (message.kind === "file-end") {
    if (!binaryFile || message.id !== binaryFile.id) throw new Error("รหัสไฟล์ไม่ตรง");
    binaryFile.ended = true;
    if (await finishIncomingFile(channel)) return;
    binaryFile.endTimer = setTimeout(() => {
      const missing = binaryFile ? binaryFile.size - binaryFile.received : 0;
      const id = binaryFile?.id;
      binaryFile = undefined;
      const text = `ไฟล์ได้รับไม่ครบ (ขาด ${missing} bytes)`;
      setStatus(`รับไฟล์ไม่สำเร็จ: ${text}`);
      if (channel.readyState === "open") channel.send(JSON.stringify({ kind: "file-error", id, message: text }));
    }, 15_000);
  }
}

async function start() {
  elements.start.disabled = true;
  setStatus("กำลังขอสิทธิ์แชร์หน้าจอ…");
  try {
    await window.remoteAgent.selectDisplay(elements.displaySource.value);
    await window.remoteAgent.setGrants({ control: elements.allowControl.checked, clipboard: elements.allowClipboard.checked, files: elements.allowFiles.checked });
    const diagnostics = await window.remoteAgent.diagnostics();
    adminMode = diagnostics.adminMode === true;
    if (window.remoteAgent.platform === "win32" && diagnostics.agentElevated) throw new Error("ไม่สามารถจับภาพเมื่อ Agent UI รันเป็น Administrator — กรุณาเปิด Agent ตามปกติ ส่วน Admin Mode จะทำงานผ่าน Input Broker แยกต่างหาก");
    if (elements.allowControl.checked) {
      if (window.remoteAgent.platform === "darwin" && diagnostics.permissions.accessibility !== "granted") throw new Error("กรุณาอนุญาต Accessibility ใน System Settings");
      setStatus(`Native control พร้อม (${diagnostics.screen.width}×${diagnostics.screen.height})${adminMode ? " • ADMIN BROKER" : " • STANDARD MODE — หน้าต่างผู้ดูแลต้องติดตั้ง Admin Broker"}`);
    }
    stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30, max: 30 }, width: { ideal: 1920, max: 1920 }, height: { ideal: 1080, max: 1080 } }, audio: false });
    elements.preview.srcObject = stream;
    elements.preview.hidden = false;
    peer = new RTCPeerConnection(rtcConfiguration());
    for (const track of stream.getTracks()) {
      if (track.kind === "video") track.contentHint = "motion";
      const sender = peer.addTrack(track, stream);
      const parameters = sender.getParameters();
      parameters.encodings ??= [{}];
      if (!parameters.encodings.length) parameters.encodings.push({});
      parameters.encodings[0].maxBitrate = 3_500_000;
      parameters.encodings[0].maxFramerate = 30;
      parameters.degradationPreference = "maintain-framerate";
      sender.setParameters(parameters).catch(console.error);
      if (track.kind === "video") videoSender = sender;
    }
    peer.onicecandidate = ({ candidate }) => { if (candidate) send({ type: "ice-candidate", candidate }); };
    peer.onicecandidateerror = ({ errorCode, errorText }) => {
      if (errorCode !== 701) setStatus(`TURN/ICE ${errorCode}: ${errorText}`);
    };
    peer.onicegatheringstatechange = () => {
      if (peer?.iceGatheringState === "gathering") setStatus("กำลังค้นหาเส้นทาง Internet/TURN…", true);
    };
    peer.ondatachannel = ({ channel }) => {
      if (channel.label === "control") attachControlChannel(channel);
      if (channel.label === "input") attachInputChannel(channel);
      if (channel.label === "file-transfer") attachFileChannel(channel);
    };
    peer.onconnectionstatechange = () => {
      setStatus(`WebRTC: ${peer.connectionState}`, peer.connectionState === "connected");
      if (peer.connectionState === "connected") {
        clearTimeout(iceTimer);
        clearInterval(qualityTimer);
        qualityTimer = setInterval(() => adaptVideoQuality().catch((error) => console.warn("ปรับคุณภาพภาพไม่ได้", error)), 3000);
      }
    };

    setStatus("แชร์หน้าจอแล้ว · กำลังเชื่อมต่อเซิร์ฟเวอร์…", true);
    socket = new WebSocket(elements.server.value);
    const activeSocket = socket;
    signalingTimer = setTimeout(() => stop("Signaling ไม่ตอบสนองภายใน 60 วินาที"), 60_000);
    socket.addEventListener("open", () => {
      if (socket !== activeSocket) return;
      clearTimeout(signalingTimer);
      send({ type: "hello", sessionId: elements.sessionId.value, joinToken: elements.joinToken.value, role: "agent" });
      setStatus("รอเจ้าหน้าที่เชื่อมต่อ…", true);
      window.remoteAgent.sessionActive(true);
    });
    socket.addEventListener("message", async ({ data }) => {
      if (socket !== activeSocket) return;
      const message = JSON.parse(data);
      if (message.type === "peer-ready") {
        try { applyNetworkConfiguration(message); }
        catch (error) { stop(error instanceof Error ? error.message : String(error)); return; }
      }
      if (message.type === "error") { stop(`Signaling: ${message.message}`); return; }
      if (message.type === "offer") await acceptOffer(message.sdp);
      if (message.type === "ice-candidate") await addRemoteCandidate(message.candidate);
      if (message.type === "end") stop("เจ้าหน้าที่สิ้นสุด session");
    });
    socket.addEventListener("close", (event) => { if (socket === activeSocket && stream) stop(`การเชื่อมต่อสิ้นสุด (${event.code})`); });
    socket.addEventListener("error", () => { if (socket === activeSocket) stop("เชื่อมต่อเซิร์ฟเวอร์ไม่สำเร็จ"); });
    stream.getVideoTracks()[0].addEventListener("ended", () => stop("หยุดแชร์หน้าจอแล้ว"));
    elements.stop.hidden = false;
    elements.regenerateCode.disabled = true;
    elements.copyCode.disabled = true;
  } catch (error) {
    stop(error instanceof Error ? error.message : "ไม่สามารถแชร์หน้าจอได้");
  }
}

function stop(reason = "ตัดการเชื่อมต่อแล้ว") {
  window.remoteAgent.releaseInput();
  window.remoteAgent.sessionActive(false);
  window.remoteAgent.setGrants({ control: false, clipboard: false, files: false });
  if (socket?.readyState === WebSocket.OPEN) send({ type: "end", reason: "user-disconnected" });
  socket?.close(); socket = undefined;
  peer?.close(); peer = undefined;
  controlChannel?.close(); controlChannel = undefined; inputChannel?.close(); inputChannel = undefined; incomingFiles.clear();
  fileChannel?.close(); fileChannel = undefined;
  if (binaryFile?.endTimer) clearTimeout(binaryFile.endTimer);
  binaryFile = undefined;
  pendingIceCandidates.length = 0; latestMoveSequence = 0; clearInterval(qualityTimer); qualityTimer = undefined; videoSender = undefined;
  clearTimeout(signalingTimer); signalingTimer = undefined; clearTimeout(iceTimer); iceTimer = undefined; relayAvailable = false;
  stream?.getTracks().forEach((track) => track.stop()); stream = undefined;
  elements.preview.srcObject = null; elements.preview.hidden = true;
  elements.stop.hidden = true; elements.start.disabled = !elements.consent.checked;
  elements.regenerateCode.disabled = false;
  elements.copyCode.disabled = false;
  setStatus(reason);
}

async function copyCredentials() {
  const text = `รหัสเครื่อง: ${elements.sessionId.value} | รหัสผ่าน: ${elements.joinToken.value}`;
  try {
    await navigator.clipboard.writeText(text);
    const original = elements.copyCode.textContent;
    elements.copyCode.textContent = "คัดลอกแล้ว ✓";
    elements.copyCode.classList.add("copied");
    setTimeout(() => {
      elements.copyCode.textContent = original;
      elements.copyCode.classList.remove("copied");
    }, 2000);
  } catch {
    setStatus("ไม่สามารถคัดลอกลงคลิปบอร์ดได้");
  }
}

elements.start.addEventListener("click", start);
elements.regenerateCode.addEventListener("click", regenerateAccessCode);
elements.copyCode.addEventListener("click", copyCredentials);
elements.stop.addEventListener("click", () => stop());
window.addEventListener("keydown", (event) => {
  if (event.ctrlKey && event.altKey && event.shiftKey && event.key === "Escape") stop("หยุดฉุกเฉินโดยผู้ใช้");
});
initializeIdentity();
loadDisplays().catch(() => setStatus("ไม่สามารถอ่านรายการหน้าจอได้"));
showPermissions();
if (window.gsap) {
  window.gsap.from(".brand > *", { opacity: 0, x: -24, duration: .65, stagger: .08, ease: "power2.out" });
  window.gsap.from(".panel > *", { opacity: 0, y: 16, duration: .5, stagger: .035, ease: "power2.out" });
}

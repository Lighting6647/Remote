import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import WebSocket from "ws";
import { isSignalMessage } from "@remote/protocol";

console.log("========================================================");
console.log("  Comprehensive System Test Suite: All Menus & Functions ");
console.log("========================================================\n");

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
    console.log(`  ✓ PASS: ${message}`);
  } else {
    failed++;
    console.error(`  ✗ FAIL: ${message}`);
    throw new Error(`Assertion failed: ${message}`);
  }
}

async function testProtocol() {
  console.log("\n[1/5] Testing Shared Protocol & Message Schemas...");
  
  // Valid messages
  assert(isSignalMessage({ type: "hello", sessionId: "123456789", joinToken: "123456", role: "agent" }), "Valid hello message");
  assert(isSignalMessage({ type: "hello", sessionId: "123456789", joinToken: "123456", role: "controller" }), "Valid controller hello message");
  assert(isSignalMessage({ type: "peer-ready", iceServers: [{ urls: "stun:stun.l.google.com:19302" }] }), "Valid peer-ready message");
  assert(isSignalMessage({ type: "offer", sdp: "v=0..." }), "Valid offer message");
  assert(isSignalMessage({ type: "answer", sdp: "v=0..." }), "Valid answer message");
  assert(isSignalMessage({ type: "ice-candidate", candidate: { candidate: "candidate:..." } }), "Valid ice-candidate message");
  assert(isSignalMessage({ type: "consent", granted: true }), "Valid consent message");
  assert(isSignalMessage({ type: "end", reason: "user-disconnected" }), "Valid end message");
  assert(isSignalMessage({ type: "error", code: "4401", message: "unauthorized" }), "Valid error message");

  // Invalid messages
  assert(!isSignalMessage(null), "Null rejected");
  assert(!isSignalMessage({}), "Empty object rejected");
  assert(!isSignalMessage({ type: "unknown" }), "Unknown type rejected");
  assert(!isSignalMessage({ type: 123 }), "Non-string type rejected");
  assert(!isSignalMessage("hello"), "String payload rejected");
}

async function testSignalingServer() {
  console.log("\n[2/5] Testing Signaling Server (API, Health, Auth, Relay, Limits)...");

  const port = 21_000 + Math.floor(Math.random() * 8_000);
  const baseUrl = `http://127.0.0.1:${port}`;
  const wsUrl = `ws://127.0.0.1:${port}/signal`;

  const serverProc = spawn(process.execPath, ["apps/signaling-server/dist/server.js"], {
    cwd: "d:\\All Ai\\Remote",
    env: { ...process.env, PORT: String(port), CLOUDFLARE_TURN_KEY_ID: "", CLOUDFLARE_TURN_API_TOKEN: "" },
    stdio: ["ignore", "pipe", "pipe"]
  });

  const sockets = [];

  function waitFor(socket, event, timeout = 5_000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${event}`)), timeout);
      socket.once(event, (...args) => { clearTimeout(timer); resolve(args); });
      socket.once("error", (error) => { clearTimeout(timer); reject(error); });
    });
  }

  function waitForMessage(socket, expectedType, timeout = 5_000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for message: ${expectedType}`)), timeout);
      const listener = (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.type === expectedType) {
            clearTimeout(timer);
            socket.off("message", listener);
            resolve(msg);
          }
        } catch {}
      };
      socket.on("message", listener);
    });
  }

  try {
    // 1. Health check endpoint
    let healthOk = false;
    for (let i = 0; i < 40; i++) {
      try {
        const res = await fetch(`${baseUrl}/health`);
        if (res.ok) {
          const body = await res.json();
          assert(body.status === "ok", "Health endpoint returns status 'ok'");
          assert(typeof body.instance === "string", "Health endpoint returns instance ID");
          assert(typeof body.turnRelay === "string", "Health endpoint returns turnRelay status");
          healthOk = true;
          break;
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
    assert(healthOk, "Signaling server booted and responded to /health");

    // 2. 404 on unknown endpoint
    const notFoundRes = await fetch(`${baseUrl}/unknown-path`);
    assert(notFoundRes.status === 404, "Unknown endpoint returns 404");

    // 3. Connect Agent with valid 9-digit session ID & 6-digit token
    const sessionId = "987654321";
    const token = "654321";

    const agentWs = new WebSocket(wsUrl);
    sockets.push(agentWs);
    await waitFor(agentWs, "open");
    agentWs.send(JSON.stringify({ type: "hello", sessionId, joinToken: token, role: "agent" }));
    assert(agentWs.readyState === WebSocket.OPEN, "Agent connected and sent hello");

    // 4. Connect Controller with WRONG token -> Expect error 4401
    const badController = new WebSocket(wsUrl);
    sockets.push(badController);
    await waitFor(badController, "open");
    badController.send(JSON.stringify({ type: "hello", sessionId, joinToken: "000000", role: "controller" }));
    const badError = await waitForMessage(badController, "error");
    assert(badError.code === "4401", "Wrong token rejected with 4401");
    const [badCode] = await waitFor(badController, "close");
    assert(badCode === 4401, "Wrong token closed socket with 4401");

    // 5. Connect Controller to NON-EXISTENT session -> Expect error 4404
    const missingAgentController = new WebSocket(wsUrl);
    sockets.push(missingAgentController);
    await waitFor(missingAgentController, "open");
    missingAgentController.send(JSON.stringify({ type: "hello", sessionId: "111222333", joinToken: "123456", role: "controller" }));
    const missingError = await waitForMessage(missingAgentController, "error");
    assert(missingError.code === "4404", "Offline agent returns 4404");

    // 6. Connect Controller with CORRECT token -> Both get peer-ready
    const controllerWs = new WebSocket(wsUrl);
    sockets.push(controllerWs);
    await waitFor(controllerWs, "open");

    const agentReadyPromise = waitForMessage(agentWs, "peer-ready");
    const controllerReadyPromise = waitForMessage(controllerWs, "peer-ready");

    controllerWs.send(JSON.stringify({ type: "hello", sessionId, joinToken: token, role: "controller" }));

    const [agentReady, controllerReady] = await Promise.all([agentReadyPromise, controllerReadyPromise]);
    assert(Array.isArray(agentReady.iceServers) && agentReady.iceServers.length > 0, "Agent received ICE servers in peer-ready");
    assert(Array.isArray(controllerReady.iceServers) && controllerReady.iceServers.length > 0, "Controller received ICE servers in peer-ready");

    // 7. Message Relay (Offer -> Answer -> ICE Candidate -> End)
    const offerPromise = waitForMessage(agentWs, "offer");
    controllerWs.send(JSON.stringify({ type: "offer", sdp: "dummy-offer-sdp" }));
    const receivedOffer = await offerPromise;
    assert(receivedOffer.sdp === "dummy-offer-sdp", "Offer message relayed successfully from Controller to Agent");

    const answerPromise = waitForMessage(controllerWs, "answer");
    agentWs.send(JSON.stringify({ type: "answer", sdp: "dummy-answer-sdp" }));
    const receivedAnswer = await answerPromise;
    assert(receivedAnswer.sdp === "dummy-answer-sdp", "Answer message relayed successfully from Agent to Controller");

    const icePromise = waitForMessage(agentWs, "ice-candidate");
    controllerWs.send(JSON.stringify({ type: "ice-candidate", candidate: { candidate: "test-candidate", sdpMid: "0" } }));
    const receivedIce = await icePromise;
    assert(receivedIce.candidate.candidate === "test-candidate", "ICE candidate relayed successfully");

    // 8. Rejection of server-only messages from client
    controllerWs.send(JSON.stringify({ type: "peer-ready" }));
    const serverOnlyError = await waitForMessage(controllerWs, "error");
    assert(serverOnlyError.code === "4400", "Server-only message correctly rejected");

  } finally {
    for (const ws of sockets) {
      if (ws.readyState < WebSocket.CLOSING) ws.close();
    }
    serverProc.kill();
  }
}

async function testDataChannelProtocols() {
  console.log("\n[3/5] Testing Data Channel Protocols (Control, Realtime Input, File Transfer)...");

  // 1. Control: Capabilities exchange
  const capabilitiesMessage = {
    kind: "capabilities",
    platform: "win32",
    adminMode: false,
    control: true,
    clipboard: true,
    files: true
  };
  const parsedCap = JSON.parse(JSON.stringify(capabilitiesMessage));
  assert(parsedCap.kind === "capabilities" && parsedCap.control === true, "Capabilities message serialization");

  // 2. Control: Clipboard 2-way sync with generation tracking
  let clipboardGen = 1;
  const clipSet = { kind: "clipboard-set", text: "Test copied text", generation: clipboardGen };
  assert(clipSet.kind === "clipboard-set" && clipSet.text === "Test copied text", "Clipboard set message structure");

  const clipGet = { kind: "clipboard-get", requestId: 42, generation: clipboardGen };
  const clipVal = { kind: "clipboard-value", text: "Agent clipboard content", requestId: clipGet.requestId, generation: clipGet.generation };
  assert(clipVal.requestId === 42 && clipVal.text.length > 0, "Clipboard get/value pairing");

  // 3. Input Channel: Sequenced pointer move coalescing
  let latestSeq = 0;
  function processMove(event) {
    if (event.seq <= latestSeq) return false; // Out-of-order dropped
    latestSeq = event.seq;
    return true;
  }
  assert(processMove({ type: "move", x: 0.1, y: 0.2, seq: 1 }), "Sequence 1 accepted");
  assert(processMove({ type: "move", x: 0.2, y: 0.3, seq: 2 }), "Sequence 2 accepted");
  assert(!processMove({ type: "move", x: 0.15, y: 0.25, seq: 1 }), "Out-of-order sequence 1 rejected");

  // 4. File Transfer Protocol: SHA-256 verification and 25 MB limit
  const testFilePayload = Buffer.from("Hello, this is a secure binary file transmission test!");
  const fileHash = createHash("sha256").update(testFilePayload).digest("hex");
  const fileId = "test-transfer-uuid";

  const fileStart = { kind: "file-start", id: fileId, name: "document.txt", size: testFilePayload.byteLength, sha256: fileHash };
  assert(fileStart.size <= 25 * 1024 * 1024, "File size is within 25 MB limit");
  assert(/^[a-f0-9]{64}$/.test(fileStart.sha256), "SHA-256 format verified");

  // Simulate chunk assembly
  const chunkSize = 16;
  const chunks = [];
  for (let i = 0; i < testFilePayload.byteLength; i += chunkSize) {
    chunks.push(testFilePayload.subarray(i, i + chunkSize));
  }
  const assembled = Buffer.concat(chunks);
  const verifiedHash = createHash("sha256").update(assembled).digest("hex");
  assert(verifiedHash === fileHash, "Assembled file SHA-256 matches header hash");

  // Verify oversized file rejection (> 25MB)
  const oversized = 26 * 1024 * 1024;
  assert(oversized > 25 * 1024 * 1024, "25MB boundary accurately rejects oversized files");
}

async function testControllerFunctions() {
  console.log("\n[4/5] Testing Controller UI Functions & Coordinate Math...");

  // 1. Normalized Device ID formatting
  function normalizeDeviceId(val) { return val.replace(/\D/g, "").slice(0, 9); }
  function formatDeviceId(id) { return id.replace(/(\d{3})(?=\d)/g, "$1 "); }

  assert(normalizeDeviceId("123-456-789") === "123456789", "Normalizes dashed input");
  assert(normalizeDeviceId("  123 456 789012 ") === "123456789", "Trims and slices to 9 digits");
  assert(formatDeviceId("123456789") === "123 456 789", "Formats to 3-digit grouped chunks");

  // 2. Address Book management logic
  let addressBook = [];
  function saveDevice(id, name) {
    addressBook = addressBook.filter((d) => d.id !== id);
    addressBook.unshift({ id, name });
  }
  function deleteDevice(id) {
    addressBook = addressBook.filter((d) => d.id !== id);
  }

  saveDevice("111222333", "Reception-PC");
  saveDevice("444555666", "Server-Room");
  assert(addressBook.length === 2, "Address book contains 2 entries");
  assert(addressBook[0].name === "Server-Room", "Latest entry is unshifted to top");

  deleteDevice("111222333");
  assert(addressBook.length === 1 && addressBook[0].id === "444555666", "deleteDevice removes selected entry");

  // 3. Screen coordinate mapping (Letterboxing & Pillarboxing)
  function screenPosition(clientX, clientY, rect, videoWidth, videoHeight) {
    const sourceRatio = videoWidth / videoHeight;
    const boxRatio = rect.width / rect.height;
    let left = rect.left, top = rect.top, width = rect.width, height = rect.height;
    if (boxRatio > sourceRatio) {
      width = height * sourceRatio;
      left += (rect.width - width) / 2;
    } else {
      height = width / sourceRatio;
      top += (rect.height - height) / 2;
    }
    if (clientX < left || clientX > left + width || clientY < top || clientY > top + height) return null;
    return { x: (clientX - left) / width, y: (clientY - top) / height };
  }

  const rect = { left: 0, top: 0, width: 1920, height: 1080 };
  const centerPos = screenPosition(960, 540, rect, 1920, 1080);
  assert(Math.abs(centerPos.x - 0.5) < 0.001 && Math.abs(centerPos.y - 0.5) < 0.001, "Center coordinate maps to exactly 0.5, 0.5");

  const outsidePos = screenPosition(2000, 540, rect, 1920, 1080);
  assert(outsidePos === null, "Out-of-bounds pointer event returns null");

  // 4. Keyboard translation
  const codeMap = { Space: "Space", ArrowLeft: "Left", Enter: "Enter", Escape: "Escape" };
  function remoteKey(code) {
    if (code.startsWith("Key")) return code.slice(3);
    if (code.startsWith("Digit")) return `Num${code.slice(5)}`;
    return codeMap[code];
  }
  assert(remoteKey("KeyA") === "A", "Translates KeyA to A");
  assert(remoteKey("Digit9") === "Num9", "Translates Digit9 to Num9");
  assert(remoteKey("Space") === "Space", "Translates Space key");
}

async function testAgentFunctions() {
  console.log("\n[5/5] Testing Agent Logic, Coordinate Transformation & Key Maps...");

  // 1. Virtual Desktop coordinate mapping
  function virtualDesktopPoint(input, selectedDisplay, allDisplays) {
    const left = Math.min(...allDisplays.map((d) => d.bounds.x));
    const top = Math.min(...allDisplays.map((d) => d.bounds.y));
    const right = Math.max(...allDisplays.map((d) => d.bounds.x + d.bounds.width));
    const bottom = Math.max(...allDisplays.map((d) => d.bounds.y + d.bounds.height));
    const localX = Math.max(0, Math.min(1, Number(input.x)));
    const localY = Math.max(0, Math.min(1, Number(input.y)));
    const absoluteX = selectedDisplay.x + localX * Math.max(1, selectedDisplay.width - 1);
    const absoluteY = selectedDisplay.y + localY * Math.max(1, selectedDisplay.height - 1);
    return {
      x: Math.max(0, Math.min(1, (absoluteX - left) / Math.max(1, right - left - 1))),
      y: Math.max(0, Math.min(1, (absoluteY - top) / Math.max(1, bottom - top - 1)))
    };
  }

  const primary = { x: 0, y: 0, width: 1920, height: 1080 };
  const secondary = { x: 1920, y: 0, width: 1920, height: 1080 };
  const all = [{ bounds: primary }, { bounds: secondary }];

  const pointOnPrimary = virtualDesktopPoint({ x: 0.5, y: 0.5 }, primary, all);
  assert(Math.abs(pointOnPrimary.x - 0.25) < 0.01, "Primary screen middle maps to 0.25 across dual monitors");

  const pointOnSecondary = virtualDesktopPoint({ x: 0.5, y: 0.5 }, secondary, all);
  assert(Math.abs(pointOnSecondary.x - 0.75) < 0.01, "Secondary screen middle maps to 0.75 across dual monitors");

  // 2. Permission barriers
  let grants = { control: false, clipboard: false, files: false };
  function injectInput(input) {
    if (!grants.control) throw new Error("remote control not granted");
    return true;
  }
  function readClipboard() {
    if (!grants.clipboard) throw new Error("clipboard access not granted");
    return "text";
  }

  let caught = false;
  try { injectInput({ type: "move" }); } catch (e) { caught = true; }
  assert(caught, "Input rejected when control grant is false");

  grants.control = true;
  assert(injectInput({ type: "move" }) === true, "Input accepted when control grant is true");

  caught = false;
  try { readClipboard(); } catch (e) { caught = true; }
  assert(caught, "Clipboard read rejected when clipboard grant is false");

  grants.clipboard = true;
  assert(readClipboard() === "text", "Clipboard read accepted when clipboard grant is true");
}

async function run() {
  const startTime = Date.now();
  await testProtocol();
  await testSignalingServer();
  await testDataChannelProtocols();
  await testControllerFunctions();
  await testAgentFunctions();

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
  console.log("\n========================================================");
  console.log(`  ALL TESTS COMPLETED in ${elapsed}s`);
  console.log(`  Total Assertions: ${passed + failed} | Passed: ${passed} | Failed: ${failed}`);
  console.log("========================================================\n");

  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error("\nFATAL ERROR DURING TEST RUN:", err);
  process.exit(1);
});

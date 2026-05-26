
(async function probeWebRTC() {
  const results = {
    supported: false,
    candidates: [],
    localIPs: [],
    sdpOffer: null,
    errors: [],
    dtls_fingerprint: null,
    ice_ufrag: null,
    ice_pwd: null,
    sctp_port: null,
    data_channel_open: false,
    data_channel_message: false,
    timing: {},
  };

  const t0 = Date.now();

  // 1. Check RTCPeerConnection availability
  if (typeof RTCPeerConnection === 'undefined') {
    results.errors.push('RTCPeerConnection is undefined');
    return results;
  }
  results.supported = true;
  results.timing.constructor = Date.now() - t0;

  // 2. Create PeerConnection with STUN
  let pc;
  try {
    pc = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
      ]
    });
  } catch (e) {
    results.errors.push('RTCPeerConnection constructor threw: ' + e.message);
    return results;
  }

  // 3. Gather ICE candidates
  const gatherDone = new Promise((resolve) => {
    const candidates = [];
    pc.onicecandidate = (evt) => {
      if (evt.candidate) {
        const c = evt.candidate;
        candidates.push({
          candidate: c.candidate,
          sdpMid: c.sdpMid,
          sdpMLineIndex: c.sdpMLineIndex,
          type: c.type || parseType(c.candidate),
          address: parseAddress(c.candidate),
          port: parsePort(c.candidate),
          protocol: parseProtocol(c.candidate),
          priority: parsePriority(c.candidate),
        });
        results.candidates.push(candidates[candidates.length - 1]);

        // Extract local IPs
        const addr = parseAddress(c.candidate);
        if (addr && !results.localIPs.includes(addr)) {
          results.localIPs.push(addr);
        }
      } else {
        // End of candidates
        results.timing.gatherComplete = Date.now() - t0;
        resolve();
      }
    };
    pc.onicegatheringstatechange = () => {
      if (pc.iceGatheringState === 'complete') {
        results.timing.gatherComplete = Date.now() - t0;
        resolve();
      }
    };
  });

  // 4. Create DataChannel (triggers ICE gathering)
  let dc;
  try {
    dc = pc.createDataChannel('velora-test', { ordered: true });
    dc.onopen = () => {
      results.data_channel_open = true;
      results.timing.dc_open = Date.now() - t0;
    };
    dc.onmessage = (e) => {
      results.data_channel_message = true;
      results.data_channel_received = e.data;
    };
    dc.onerror = (e) => {
      results.errors.push('DataChannel error: ' + (e.message || String(e)));
    };
  } catch (e) {
    results.errors.push('createDataChannel threw: ' + e.message);
  }

  // 5. createOffer
  let offer;
  try {
    offer = await pc.createOffer();
    results.timing.createOffer = Date.now() - t0;
  } catch (e) {
    results.errors.push('createOffer threw: ' + e.message);
    pc.close();
    return results;
  }

  results.sdpOffer = offer.sdp;

  // 6. Parse SDP for key fields
  try {
    const sdp = offer.sdp;
    const fingerprintMatch = sdp.match(/a=fingerprint:(\S+) ([\da-fA-F:]+)/);
    if (fingerprintMatch) {
      results.dtls_fingerprint = { algo: fingerprintMatch[1], value: fingerprintMatch[2] };
    }
    const ufragMatch = sdp.match(/a=ice-ufrag:(\S+)/);
    if (ufragMatch) results.ice_ufrag = ufragMatch[1];
    const pwdMatch = sdp.match(/a=ice-pwd:(\S+)/);
    if (pwdMatch) results.ice_pwd = pwdMatch[1];
    const sctpMatch = sdp.match(/a=sctp-port:(\d+)/);
    if (sctpMatch) results.sctp_port = parseInt(sctpMatch[1]);
  } catch (e) {
    results.errors.push('SDP parse error: ' + e.message);
  }

  // 7. setLocalDescription — triggers ICE gathering
  try {
    await pc.setLocalDescription(offer);
    results.timing.setLocal = Date.now() - t0;
  } catch (e) {
    results.errors.push('setLocalDescription threw: ' + e.message);
    pc.close();
    return results;
  }

  // 8. Wait for ICE gathering (up to 10s)
  await Promise.race([
    gatherDone,
    new Promise((_, reject) => setTimeout(() => reject(new Error('ICE gather timeout')), 10000))
  ]).catch(e => results.errors.push(e.message));

  results.timing.total = Date.now() - t0;
  pc.close();
  return results;

  // ── SDP parsing helpers ──────────────────────────────────────────────────
  function parseType(candidate) {
    const m = candidate.match(/typ (\w+)/);
    return m ? m[1] : 'unknown';
  }
  function parseAddress(candidate) {
    // candidate:foundation component protocol priority addr port typ ...
    const parts = candidate.split(' ');
    return parts[4] || null;
  }
  function parsePort(candidate) {
    const parts = candidate.split(' ');
    return parts[5] ? parseInt(parts[5]) : null;
  }
  function parseProtocol(candidate) {
    const parts = candidate.split(' ');
    return parts[2] || null;
  }
  function parsePriority(candidate) {
    const parts = candidate.split(' ');
    return parts[3] ? parseInt(parts[3]) : null;
  }
})();

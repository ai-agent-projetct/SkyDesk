// Browser practice simulator.
// ponytail: simplified position-hold multirotor model (not ArduPilot SITL). Good for stick orientation drills; swap in SITL if you need real flight dynamics.
(function () {
  const cfg = JSON.parse(document.getElementById('simCfg').textContent); // { testId, exercises }
  const cv = document.getElementById('sim'), ctx = cv.getContext('2d'), $ = id => document.getElementById(id);
  const store = { get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage blocked */ } } };
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  // ---------- drills ----------
  const PAD = 1.5, CEIL = 12, FENCE = 35;
  const wp = (x, y, z = 4) => ({ x, y, z });
  const EX = {
    hover: { name: 'Take-off, hover & land', limit: 120, hold: true, targets: [] },
    square: { name: 'Square pattern (10 m)', limit: 240, targets: [wp(-5, 10), wp(5, 10), wp(5, 20), wp(-5, 20), wp(0, 0, 3)] },
    eight: { name: 'Figure-8', limit: 300, targets: [wp(0, 15), wp(-6, 20), wp(-11, 15), wp(-6, 10), wp(0, 15), wp(6, 20), wp(11, 15), wp(6, 10), wp(0, 15), wp(0, 0, 3)] },
    // Spray a 20 × 12 m field in 2.5 m lanes at 3 m; at least 70% of it must be covered.
    agri: { name: 'Agri spray field', limit: 420, field: { x0: -10, x1: 10, y0: 8, y1: 20 }, sayNext: 'spray',
      targets: [9, 11.5, 14, 16.5, 19].flatMap((y, i) => (i % 2 ? [wp(10, y, 3), wp(-10, y, 3)] : [wp(-10, y, 3), wp(10, y, 3)])).concat([wp(0, 0, 3)]) },
    // Four 3 × 3 m gates on a 10 m circle, flown anticlockwise through the frame (2.5 m centre height).
    gates: { name: 'FPV gate course', limit: 240, sayNext: 'gate', targets: [],
      gates: [[0, 8, Math.PI / 2], [10, 18, 0], [0, 28, -Math.PI / 2], [-10, 18, Math.PI]].map(([x, y, yaw]) => ({ x, y, yaw })) },
    free: { name: 'Free flight', limit: 0, targets: [] },
  };
  const TEXT = {
    arm: 'Arm the motors (hold throttle down + yaw right, or press Arm), then take off.', takeoff: 'Take off and climb to 3 m above the pad.',
    hold: 'Hold a steady hover inside the ring for 10 seconds.', next: 'Fly to the highlighted marker.', gates: 'Fly through the highlighted gate.',
    land: 'Land gently on the pad.', free: 'Free flight — practise anything. Stay inside the red fence.',
  };
  // Voice coaching in 11 Indian languages. Translations are simple machine-drafted phrases — have a native speaker review them.
  const PHR = {
    'en-IN': { takeoff: 'Take off and climb to three metres.', hold: 'Hold your position.', next: 'Fly to the next marker.', land: 'Now land on the pad.', high: 'Too high. Descend.', far: 'Too far. Come back.', done: 'Well done. Exercise complete.', fail: 'Exercise failed. Try again.', crash: 'Crash. Land more gently.' },
    'hi-IN': { takeoff: 'टेक ऑफ करें और तीन मीटर तक ऊपर जाएं।', hold: 'अपनी जगह पर स्थिर रहें।', next: 'अगले निशान की ओर उड़ें।', land: 'अब पैड पर उतरें।', high: 'बहुत ऊँचा। नीचे आएं।', far: 'बहुत दूर। वापस आएं।', done: 'बहुत बढ़िया। अभ्यास पूरा हुआ।', fail: 'अभ्यास असफल। फिर से प्रयास करें।', crash: 'दुर्घटना। धीरे से उतरें।' },
    'ta-IN': { takeoff: 'மேலே எழுந்து மூன்று மீட்டர் உயரத்திற்கு செல்லுங்கள்.', hold: 'உங்கள் இடத்தில் நிலையாக இருங்கள்.', next: 'அடுத்த குறியை நோக்கி பறக்கவும்.', land: 'இப்போது பேடில் தரையிறங்குங்கள்.', high: 'மிக உயரம். கீழே இறங்குங்கள்.', far: 'மிக தொலைவு. திரும்பி வாருங்கள்.', done: 'அருமை. பயிற்சி முடிந்தது.', fail: 'பயிற்சி தோல்வி. மீண்டும் முயற்சிக்கவும்.', crash: 'விபத்து. மெதுவாக தரையிறங்குங்கள்.' },
    'te-IN': { takeoff: 'టేకాఫ్ చేసి మూడు మీటర్ల ఎత్తుకు వెళ్ళండి.', hold: 'మీ స్థానంలో స్థిరంగా ఉండండి.', next: 'తదుపరి గుర్తు వైపు ఎగరండి.', land: 'ఇప్పుడు ప్యాడ్ పై దిగండి.', high: 'చాలా ఎత్తులో ఉన్నారు. కిందకు దిగండి.', far: 'చాలా దూరం వెళ్ళారు. వెనక్కి రండి.', done: 'బాగుంది. అభ్యాసం పూర్తయింది.', fail: 'అభ్యాసం విఫలమైంది. మళ్ళీ ప్రయత్నించండి.', crash: 'క్రాష్ అయింది. మెల్లగా దిగండి.' },
    'kn-IN': { takeoff: 'ಟೇಕ್ ಆಫ್ ಮಾಡಿ ಮೂರು ಮೀಟರ್ ಎತ್ತರಕ್ಕೆ ಏರಿ.', hold: 'ನಿಮ್ಮ ಸ್ಥಾನದಲ್ಲಿ ಸ್ಥಿರವಾಗಿರಿ.', next: 'ಮುಂದಿನ ಗುರುತಿನ ಕಡೆಗೆ ಹಾರಿ.', land: 'ಈಗ ಪ್ಯಾಡ್ ಮೇಲೆ ಇಳಿಯಿರಿ.', high: 'ತುಂಬಾ ಎತ್ತರ. ಕೆಳಗೆ ಇಳಿಯಿರಿ.', far: 'ತುಂಬಾ ದೂರ. ಹಿಂತಿರುಗಿ ಬನ್ನಿ.', done: 'ಚೆನ್ನಾಗಿದೆ. ಅಭ್ಯಾಸ ಪೂರ್ಣಗೊಂಡಿದೆ.', fail: 'ಅಭ್ಯಾಸ ವಿಫಲವಾಗಿದೆ. ಮತ್ತೆ ಪ್ರಯತ್ನಿಸಿ.', crash: 'ಅಪಘಾತ. ನಿಧಾನವಾಗಿ ಇಳಿಯಿರಿ.' },
    'ml-IN': { takeoff: 'ടേക്ക് ഓഫ് ചെയ്ത് മൂന്ന് മീറ്റർ ഉയരത്തിലേക്ക് പോകുക.', hold: 'നിങ്ങളുടെ സ്ഥാനത്ത് സ്ഥിരമായി നിൽക്കുക.', next: 'അടുത്ത അടയാളത്തിലേക്ക് പറക്കുക.', land: 'ഇപ്പോൾ പാഡിൽ ഇറങ്ങുക.', high: 'വളരെ ഉയരത്തിലാണ്. താഴേക്ക് ഇറങ്ങുക.', far: 'വളരെ ദൂരെയാണ്. തിരികെ വരിക.', done: 'നന്നായി. പരിശീലനം പൂർത്തിയായി.', fail: 'പരിശീലനം പരാജയപ്പെട്ടു. വീണ്ടും ശ്രമിക്കുക.', crash: 'ക്രാഷ്. പതുക്കെ ഇറങ്ങുക.' },
    'mr-IN': { takeoff: 'टेक ऑफ करा आणि तीन मीटर उंचीवर जा.', hold: 'आपल्या जागी स्थिर राहा.', next: 'पुढील खुणेकडे उडा.', land: 'आता पॅडवर उतरा.', high: 'खूप उंच. खाली या.', far: 'खूप दूर. परत या.', done: 'छान. सराव पूर्ण झाला.', fail: 'सराव अयशस्वी. पुन्हा प्रयत्न करा.', crash: 'अपघात. हळूवार उतरा.' },
    'bn-IN': { takeoff: 'টেক অফ করুন এবং তিন মিটার উচ্চতায় উঠুন।', hold: 'নিজের জায়গায় স্থির থাকুন।', next: 'পরের চিহ্নের দিকে উড়ুন।', land: 'এখন প্যাডে নামুন।', high: 'খুব উঁচু। নিচে নামুন।', far: 'খুব দূরে। ফিরে আসুন।', done: 'খুব ভালো। অনুশীলন সম্পূর্ণ।', fail: 'অনুশীলন ব্যর্থ। আবার চেষ্টা করুন।', crash: 'দুর্ঘটনা। আস্তে নামুন।' },
    'gu-IN': { takeoff: 'ટેક ઓફ કરો અને ત્રણ મીટરની ઊંચાઈ સુધી જાઓ.', hold: 'તમારી જગ્યાએ સ્થિર રહો.', next: 'આગલા નિશાન તરફ ઉડો.', land: 'હવે પેડ પર ઉતરો.', high: 'ખૂબ ઊંચે. નીચે આવો.', far: 'ખૂબ દૂર. પાછા આવો.', done: 'શાબાશ. અભ્યાસ પૂર્ણ થયો.', fail: 'અભ્યાસ નિષ્ફળ. ફરી પ્રયાસ કરો.', crash: 'અકસ્માત. ધીમેથી ઉતરો.' },
    'pa-IN': { takeoff: 'ਟੇਕ ਆਫ਼ ਕਰੋ ਅਤੇ ਤਿੰਨ ਮੀਟਰ ਦੀ ਉਚਾਈ ਤੱਕ ਜਾਓ।', hold: 'ਆਪਣੀ ਥਾਂ ਉੱਤੇ ਸਥਿਰ ਰਹੋ।', next: 'ਅਗਲੇ ਨਿਸ਼ਾਨ ਵੱਲ ਉੱਡੋ।', land: 'ਹੁਣ ਪੈਡ ਉੱਤੇ ਉਤਰੋ।', high: 'ਬਹੁਤ ਉੱਚਾ। ਹੇਠਾਂ ਆਓ।', far: 'ਬਹੁਤ ਦੂਰ। ਵਾਪਸ ਆਓ।', done: 'ਸ਼ਾਬਾਸ਼। ਅਭਿਆਸ ਪੂਰਾ ਹੋਇਆ।', fail: 'ਅਭਿਆਸ ਅਸਫਲ। ਦੁਬਾਰਾ ਕੋਸ਼ਿਸ਼ ਕਰੋ।', crash: 'ਹਾਦਸਾ। ਹੌਲੀ ਉਤਰੋ।' },
    'or-IN': { takeoff: 'ଟେକ ଅଫ କରନ୍ତୁ ଏବଂ ତିନି ମିଟର ଉଚ୍ଚତାକୁ ଯାଆନ୍ତୁ।', hold: 'ନିଜ ସ୍ଥାନରେ ସ୍ଥିର ରୁହନ୍ତୁ।', next: 'ପରବର୍ତ୍ତୀ ଚିହ୍ନ ଆଡକୁ ଉଡ଼ନ୍ତୁ।', land: 'ବର୍ତ୍ତମାନ ପ୍ୟାଡରେ ଅବତରଣ କରନ୍ତୁ।', high: 'ବହୁତ ଉଚ୍ଚ। ତଳକୁ ଆସନ୍ତୁ।', far: 'ବହୁତ ଦୂର। ଫେରି ଆସନ୍ତୁ।', done: 'ବହୁତ ଭଲ। ଅଭ୍ୟାସ ସମ୍ପୂର୍ଣ୍ଣ ହେଲା।', fail: 'ଅଭ୍ୟାସ ବିଫଳ। ପୁଣି ଚେଷ୍ଟା କରନ୍ତୁ।', crash: 'ଦୁର୍ଘଟଣା। ଧୀରେ ଅବତରଣ କରନ୍ତୁ।' },
  };
  const PHR2 = {
    'en-IN': { armed: 'Motors armed.', disarmed: 'Motors disarmed.', lowbat: 'Battery low. Return home.', rtl: 'Returning home.', gate: 'Fly through the next gate.', spray: 'Spray the field, row by row.' },
    'hi-IN': { armed: 'मोटर चालू।', disarmed: 'मोटर बंद।', lowbat: 'बैटरी कम है। वापस लौटें।', rtl: 'घर लौट रहे हैं।', gate: 'अगले गेट से होकर उड़ें।', spray: 'खेत पर पंक्ति दर पंक्ति छिड़काव करें।' },
    'ta-IN': { armed: 'மோட்டார்கள் இயக்கப்பட்டன.', disarmed: 'மோட்டார்கள் நிறுத்தப்பட்டன.', lowbat: 'பேட்டரி குறைவு. திரும்பி வாருங்கள்.', rtl: 'வீட்டிற்கு திரும்புகிறது.', gate: 'அடுத்த வாயில் வழியாக பறக்கவும்.', spray: 'வயலில் வரிசை வரிசையாக தெளிக்கவும்.' },
    'te-IN': { armed: 'మోటార్లు ఆన్ అయ్యాయి.', disarmed: 'మోటార్లు ఆఫ్ అయ్యాయి.', lowbat: 'బ్యాటరీ తక్కువగా ఉంది. వెనక్కి రండి.', rtl: 'ఇంటికి తిరిగి వస్తోంది.', gate: 'తదుపరి గేట్ గుండా ఎగరండి.', spray: 'పొలంలో వరుస వరుసగా పిచికారీ చేయండి.' },
    'kn-IN': { armed: 'ಮೋಟಾರ್‌ಗಳು ಆನ್ ಆಗಿವೆ.', disarmed: 'ಮೋಟಾರ್‌ಗಳು ಆಫ್ ಆಗಿವೆ.', lowbat: 'ಬ್ಯಾಟರಿ ಕಡಿಮೆ. ಹಿಂತಿರುಗಿ.', rtl: 'ಮನೆಗೆ ಹಿಂತಿರುಗುತ್ತಿದೆ.', gate: 'ಮುಂದಿನ ಗೇಟ್ ಮೂಲಕ ಹಾರಿ.', spray: 'ಹೊಲದಲ್ಲಿ ಸಾಲು ಸಾಲಾಗಿ ಸಿಂಪಡಿಸಿ.' },
    'ml-IN': { armed: 'മോട്ടോറുകൾ ഓണായി.', disarmed: 'മോട്ടോറുകൾ ഓഫായി.', lowbat: 'ബാറ്ററി കുറവാണ്. തിരികെ വരിക.', rtl: 'വീട്ടിലേക്ക് മടങ്ങുന്നു.', gate: 'അടുത്ത ഗേറ്റിലൂടെ പറക്കുക.', spray: 'വയലിൽ വരിവരിയായി തളിക്കുക.' },
    'mr-IN': { armed: 'मोटर सुरू झाल्या.', disarmed: 'मोटर बंद झाल्या.', lowbat: 'बॅटरी कमी आहे. परत या.', rtl: 'घरी परत येत आहे.', gate: 'पुढील गेटमधून उडा.', spray: 'शेतात ओळीने फवारणी करा.' },
    'bn-IN': { armed: 'মোটর চালু হয়েছে।', disarmed: 'মোটর বন্ধ হয়েছে।', lowbat: 'ব্যাটারি কম। ফিরে আসুন।', rtl: 'বাড়ি ফিরছে।', gate: 'পরের গেটের মধ্য দিয়ে উড়ুন।', spray: 'মাঠে সারি ধরে স্প্রে করুন।' },
    'gu-IN': { armed: 'મોટર ચાલુ થઈ.', disarmed: 'મોટર બંધ થઈ.', lowbat: 'બેટરી ઓછી છે. પાછા આવો.', rtl: 'ઘરે પાછા આવી રહ્યું છે.', gate: 'આગલા ગેટમાંથી ઉડો.', spray: 'ખેતરમાં હાર પ્રમાણે છંટકાવ કરો.' },
    'pa-IN': { armed: 'ਮੋਟਰਾਂ ਚਾਲੂ ਹੋ ਗਈਆਂ।', disarmed: 'ਮੋਟਰਾਂ ਬੰਦ ਹੋ ਗਈਆਂ।', lowbat: 'ਬੈਟਰੀ ਘੱਟ ਹੈ। ਵਾਪਸ ਆਓ।', rtl: 'ਘਰ ਵਾਪਸ ਆ ਰਿਹਾ ਹੈ।', gate: 'ਅਗਲੇ ਗੇਟ ਵਿੱਚੋਂ ਉੱਡੋ।', spray: 'ਖੇਤ ਵਿੱਚ ਕਤਾਰ ਦਰ ਕਤਾਰ ਛਿੜਕਾਅ ਕਰੋ।' },
    'or-IN': { armed: 'ମୋଟର ଚାଲୁ ହେଲା।', disarmed: 'ମୋଟର ବନ୍ଦ ହେଲା।', lowbat: 'ବ୍ୟାଟେରୀ କମ୍। ଫେରି ଆସନ୍ତୁ।', rtl: 'ଘରକୁ ଫେରୁଛି।', gate: 'ପରବର୍ତ୍ତୀ ଗେଟ୍ ଦେଇ ଉଡ଼ନ୍ତୁ।', spray: 'କ୍ଷେତରେ ଧାଡ଼ି ଧାଡ଼ି କରି ସ୍ପ୍ରେ କରନ୍ତୁ।' },
  };
  for (const k in PHR2) Object.assign(PHR[k], PHR2[k]);
  let lang = store.get('simLang', 'en-IN'), voiceOn = store.get('simVoice', true), lastWarn = 0;
  function say(key) {
    if (!voiceOn || !window.speechSynthesis) return;
    const u = new SpeechSynthesisUtterance((PHR[lang] || PHR['en-IN'])[key]);
    u.lang = lang; u.voice = speechSynthesis.getVoices().find(v => v.lang === lang) || null;
    speechSynthesis.cancel(); speechSynthesis.speak(u);
  }
  const warn = key => { if (performance.now() - lastWarn > 4000) { lastWarn = performance.now(); say(key); } };

  // ---------- inputs: keyboard (mode 2) or USB transmitter / gamepad ----------
  const sticks = { thr: 0, yaw: 0, pitch: 0, roll: 0 }, keys = {};
  const axesCfg = store.get('simAxes', { enabled: true, thr: { axis: 1, inv: true }, yaw: { axis: 0, inv: false }, pitch: { axis: 3, inv: true }, roll: { axis: 2, inv: false } });
  axesCfg.center ||= []; // per-axis resting offsets from "Calibrate centre"
  const typing = () => /INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName || '');
  addEventListener('keydown', e => {
    if (typing()) return;
    if (/^Arrow| $/.test(e.key)) e.preventDefault();
    const k = e.key.toLowerCase();
    if (!e.repeat) {
      if (k === ' ') restart();
      else if (k === '1' || k === '2' || k === '3') setMode({ 1: 'stabilize', 2: 'althold', 3: 'loiter' }[k]);
      else if (k === 't') takeoff();
      else if (k === 'r') rtl();
    }
    keys[k] = true;
  });
  addEventListener('keyup', e => { keys[e.key.toLowerCase()] = false; });
  function readInputs(dt) {
    const gp = [...(navigator.getGamepads?.() || [])].find(Boolean);
    $('gpStatus').textContent = gp ? `Controller: ${gp.id.slice(0, 40)} — axes ${gp.axes.map(a => a.toFixed(2)).join(' ')}` : 'No controller detected — using keyboard.';
    if (gp && axesCfg.enabled && !demo) {
      for (const k of ['thr', 'yaw', 'pitch', 'roll']) {
        const c = axesCfg[k]; let v = (gp.axes[c.axis] || 0) - (axesCfg.center[c.axis] || 0);
        if (c.inv) v = -v; sticks[k] = Math.abs(v) < 0.06 ? 0 : clamp(v, -1, 1);
      }
      return;
    }
    if (demo) return autopilot();
    const want = { thr: (keys.w ? 1 : 0) - (keys.s ? 1 : 0), yaw: (keys.d ? 1 : 0) - (keys.a ? 1 : 0), pitch: (keys.arrowup ? 1 : 0) - (keys.arrowdown ? 1 : 0), roll: (keys.arrowright ? 1 : 0) - (keys.arrowleft ? 1 : 0) };
    for (const k in want) sticks[k] += (want[k] - sticks[k]) * Math.min(1, 6 * dt); // spring-back like a real stick
  }

  // ---------- flight model ----------
  // Profiles: top speed / climb rate / how briskly it responds / yaw rate. "From my flight" profiles come from uploaded logs.
  const PROFILES = { trainer: { maxV: 5, maxVz: 2.5, acc: 1.6, yaw: 1.8 }, sport: { maxV: 12, maxVz: 5, acc: 2.6, yaw: 2.6 }, agri: { maxV: 7, maxVz: 2, acc: 0.9, yaw: 1.0 } };
  (cfg.profiles || []).forEach(p => { PROFILES['log' + p.id] = { maxV: p.maxV, maxVz: p.maxVz, acc: clamp(p.maxV / 5, 1, 3), yaw: 1.8 }; });
  let prof = PROFILES[store.get('simProfile', 'trainer')] || PROFILES.trainer;
  // Modes: Loiter holds position (GPS) and height; AltHold holds height only (drifts, keeps momentum);
  // Stabilize holds neither — centred throttle sinks slowly, the pilot manages height and drift.
  const MODES = { stabilize: 'Stabilize', althold: 'AltHold', loiter: 'Loiter' };
  let mode = store.get('simMode', 'loiter');
  let drone, wind = { x: 0, y: 0 }, windOn = false, simT = 0, gestT = 0, gestLatch = false, idleT = 0;
  function reset() {
    drone = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, yaw: 0, landed: true, crashed: false, armed: false, bat: 100, batWarn: false, batFs: false, auto: null };
    for (const k in sticks) sticks[k] = 0;
  }
  function arm() {
    const s = drone;
    if (s.armed || s.crashed) return;
    if (!s.landed) return note('Arm on the ground only.');
    if (s.bat < 10) return note('Battery too low to arm — press Space to restart with a fresh pack.');
    s.armed = true; idleT = 0; say('armed');
  }
  function disarm() { if (drone.armed && drone.landed) { drone.armed = false; drone.auto = null; say('disarmed'); } }
  function takeoff() { const s = drone; if (!s.armed) arm(); if (s.armed && s.landed) s.auto = { type: 'takeoff', alt: 3 }; }
  function rtl() { const s = drone; if (s.armed && !s.landed) { s.auto = { type: 'rtl' }; say('rtl'); } }
  function setMode(m) { mode = m; store.set('simMode', m); if (drone.auto && drone.auto.type !== 'land') drone.auto = null; document.querySelectorAll('[data-mode]').forEach(b => b.classList.toggle('pri', b.dataset.mode === m)); }
  let noteText = '', noteUntil = 0;
  function note(t) { noteText = t; noteUntil = performance.now() + 3000; }
  // Automatic manoeuvres produce stick commands like a pilot would (loiter-style).
  function autoSticks(s) {
    const a = s.auto; let tx = s.x, ty = s.y, tz = s.z, down = false;
    if (a.type === 'takeoff') { tz = a.alt; if (s.z >= a.alt - 0.15) s.auto = null; }
    else if (a.type === 'rtl') { const d = Math.hypot(s.x, s.y); if (d > 1 && s.z < 4.5) tz = 5; else if (d > 0.5) { tx = 0; ty = 0; tz = Math.max(s.z, 5); } else { tx = ty = 0; down = true; } }
    else down = true; // land where it is
    const vx = clamp((tx - s.x) * 0.8, -prof.maxV * 0.8, prof.maxV * 0.8), vy = clamp((ty - s.y) * 0.8, -prof.maxV * 0.8, prof.maxV * 0.8), sin = Math.sin(s.yaw), cos = Math.cos(s.yaw);
    return { pitch: clamp((vx * sin + vy * cos) / prof.maxV, -1, 1), roll: clamp((vx * cos - vy * sin) / prof.maxV, -1, 1), yaw: 0,
      thr: down ? (s.z > 2 ? -0.6 : -0.3) : clamp((tz - s.z) * 0.8, -1, 1), loiter: true };
  }
  function physics(dt) {
    simT += dt;
    wind = windOn ? { x: 1.2 * Math.sin(simT * 0.13) + 0.5 * Math.sin(simT * 0.9), y: 0.8 * Math.cos(simT * 0.11) } : { x: 0, y: 0 };
    const s = drone, st = sticks;
    // Mode-2 arming gesture on the ground: throttle down + yaw right (arm) / left (disarm), held 1.5 s.
    if (s.landed && st.thr < -0.8 && Math.abs(st.yaw) > 0.8) { if (!gestLatch && (gestT += dt) > 1.5) { st.yaw > 0 ? arm() : disarm(); gestLatch = true; } }
    else { gestT = 0; gestLatch = false; }
    if (s.crashed) { s.vx = s.vy = s.vz = 0; return; }
    if (!s.armed) { // motors off: on the ground it sits, in the air it falls
      if (s.z > 0) { s.vz -= 9.8 * dt; s.z += s.vz * dt; s.x += s.vx * dt; s.y += s.vy * dt; }
      if (s.z <= 0) { if (s.vz < -2.2) s.crashed = true; s.z = 0; s.vz = 0; s.vx = s.vy = 0; s.landed = true; }
      return;
    }
    // Battery: ~7 minutes of normal flying; warning at 30%, return-home failsafe at 15%, forced landing when empty.
    if (!s.landed) s.bat = Math.max(0, s.bat - dt * (0.2 + 0.08 * Math.abs(st.thr) + 0.015 * Math.hypot(s.vx, s.vy)));
    if (s.bat <= 30 && !s.batWarn) { s.batWarn = true; say('lowbat'); }
    if (s.bat <= 15 && !s.batFs && !s.landed) { s.batFs = true; s.auto = { type: 'rtl' }; say('rtl'); }
    if (s.bat <= 0 && !s.landed && s.auto?.type !== 'land') s.auto = { type: 'land' };
    if (s.auto && s.auto.type !== 'land' && !s.batFs && [st.pitch, st.roll, st.yaw].some(v => Math.abs(v) > 0.5)) s.auto = null; // pilot takes over
    const c = s.auto ? autoSticks(s) : st, m = c.loiter ? 'loiter' : mode;
    if (s.landed && c.thr <= 0.05) { // idle on the ground; auto-disarm after 5 s like a real flight controller
      s.vx = s.vy = s.vz = 0;
      if ((idleT += dt) > 5 || (s.auto && s.auto.type !== 'takeoff')) { s.auto = null; disarm(); }
      return;
    }
    idleT = 0;
    const sin = Math.sin(s.yaw), cos = Math.cos(s.yaw), air = s.landed ? 0 : 1;
    const wantX = (c.pitch * sin + c.roll * cos) * prof.maxV, wantY = (c.pitch * cos - c.roll * sin) * prof.maxV;
    if (m === 'loiter') { // velocity command, GPS cancels most of the wind
      const a = Math.min(1, prof.acc * dt);
      s.vx += (wantX + wind.x * 0.15 * air - s.vx) * a; s.vy += (wantY + wind.y * 0.15 * air - s.vy) * a;
    } else { // tilt = acceleration; drag and wind act on it, nothing brings it back
      s.vx += (wantX * 0.6 * prof.acc - 0.35 * (s.vx - wind.x * air)) * dt; s.vy += (wantY * 0.6 * prof.acc - 0.35 * (s.vy - wind.y * air)) * dt;
    }
    if (m === 'stabilize') s.vz += ((c.thr - 0.1) * 8 - 1.2 * s.vz) * dt; // must hold a little up-throttle to hover
    else s.vz += (c.thr * prof.maxVz - s.vz) * Math.min(1, 3 * dt);
    s.yaw += c.yaw * prof.yaw * dt;
    s.x += s.vx * dt; s.y += s.vy * dt; s.z += s.vz * dt;
    if (s.z <= 0) { if (!s.landed && s.vz < -2.2) { s.crashed = true; s.armed = false; } s.z = 0; s.vz = 0; s.landed = true; s.vx = s.vy = 0; }
    else if (s.z > 0.05) s.landed = false;
  }

  // ---------- drill state machine ----------
  let run = null, demo = false, queue = [], results = [], testDeadline = 0, lastTrace = null, replay = null;
  function start(key) {
    reset(); replay = null;
    const ex = EX[key], f = ex.field;
    run = { key, ex, phase: key === 'free' ? 'free' : 'takeoff', idx: 0, t: 0, holdT: 0, pen: 0, trace: [], traceT: 0,
      cov: f ? new Uint8Array((f.x1 - f.x0) * (f.y1 - f.y0)) : null, covN: 0, prev: null };
    if (demo) drone.armed = true;
    say(key === 'free' ? 'next' : 'takeoff'); panel();
  }
  const restart = () => { demo = false; run ? start(run.key) : reset(); };
  function step(dt) {
    if (!run || run.phase === 'done') return;
    const before = run.phase + run.idx;
    advance(dt);
    if (run.phase !== 'done' && run.phase + run.idx !== before) panel(); // refresh the instruction on every phase / marker change
  }
  const coverage = () => (run.cov ? run.covN / run.cov.length : 0);
  function spray(s) { // mark 1 m cells within ±1.5 m of the drone while it is inside the field at spraying height
    const f = run.ex.field; if (!f || s.z < 1.5 || s.z > 4.5) return;
    for (let x = Math.floor(s.x - 1.5); x <= s.x + 1.5; x++) for (let y = Math.floor(s.y - 1.5); y <= s.y + 1.5; y++) {
      if (x < f.x0 || x >= f.x1 || y < f.y0 || y >= f.y1) continue;
      const i = (y - f.y0) * (f.x1 - f.x0) + (x - f.x0);
      if (!run.cov[i]) { run.cov[i] = 1; run.covN++; }
    }
  }
  function throughGate(g, a, b) { // did the segment a→b cross gate g's plane forwards, inside its 3 × 3 m frame?
    const nx = Math.sin(g.yaw), ny = Math.cos(g.yaw), da = (a.x - g.x) * nx + (a.y - g.y) * ny, db = (b.x - g.x) * nx + (b.y - g.y) * ny;
    if (!(da < 0 && db >= 0)) return false;
    const k = da / (da - db), px = a.x + (b.x - a.x) * k, py = a.y + (b.y - a.y) * k, pz = a.z + (b.z - a.z) * k;
    return Math.abs((px - g.x) * ny - (py - g.y) * nx) < 1.5 && pz > 1 && pz < 4;
  }
  function advance(dt) {
    const s = drone, d0 = Math.hypot(s.x, s.y), here = { x: s.x, y: s.y, z: s.z };
    run.t += dt;
    if ((run.traceT += dt) >= 0.1) { run.traceT = 0; run.trace.push([+run.t.toFixed(1), s.x, s.y, s.z, s.yaw]); }
    if (s.z > CEIL || d0 > FENCE) { run.pen += dt; warn(s.z > CEIL ? 'high' : 'far'); }
    if (run.cov) spray(s);
    const prev = run.prev; run.prev = here;
    if (run.phase === 'free') return;
    if (s.crashed) return finish(false, 'crash');
    if (run.ex.limit && run.t > run.ex.limit) return finish(false, 'fail');
    if (run.phase === 'takeoff' && s.z >= 2.5) { run.phase = run.ex.hold ? 'hold' : run.ex.gates ? 'gates' : 'wp'; say(run.ex.hold ? 'hold' : run.ex.sayNext || 'next'); }
    else if (run.phase === 'hold') {
      if (d0 < PAD && s.z > 2 && s.z < 4.5) { run.holdT += dt; if (run.holdT >= 10) { run.phase = 'land'; say('land'); } } else run.holdT = 0;
    } else if (run.phase === 'gates') {
      if (prev && throughGate(run.ex.gates[run.idx], prev, here)) { if (++run.idx >= run.ex.gates.length) { run.phase = 'land'; say('land'); } else say('gate'); }
    } else if (run.phase === 'wp') {
      const w = run.ex.targets[run.idx];
      if (Math.hypot(s.x - w.x, s.y - w.y) < 1.5 && Math.abs(s.z - w.z) < 1.5 && ++run.idx >= run.ex.targets.length) { run.phase = 'land'; say('land'); }
      else if (run.idx && run.ex.targets[run.idx] !== w) say(run.ex.sayNext || 'next');
    } else if (run.phase === 'land' && s.landed) {
      const ok = d0 < PAD && run.pen < 10 && (!run.cov || coverage() >= 0.7);
      finish(ok, ok ? 'done' : 'fail');
    }
  }
  function finish(passed, sayKey) {
    run.phase = 'done'; run.passed = passed; say(sayKey);
    lastTrace = run.trace.length > 5 ? run.trace : lastTrace; $('replayBtn').disabled = !lastTrace;
    const r = { exercise: run.key, passed: passed ? 1 : 0, seconds: Math.round(run.t), penalties: Math.round(run.pen) };
    if (!demo) {
      if (cfg.testId && queue.length + results.length) { results.push(r); if (queue.length) setTimeout(() => start(queue.shift()), 3000); else submitTest(); }
      else fetch('/simulator/run', { method: 'POST', body: new URLSearchParams(r) }).catch(() => {});
    }
    panel();
  }
  function submitTest() {
    const f = document.createElement('form'); f.method = 'post'; f.action = `/simulator/test/${cfg.testId}`;
    const i = document.createElement('input'); i.name = 'results'; i.value = JSON.stringify(results); f.append(i); document.body.append(f); f.submit();
  }
  // "Watch then fly": autopilot flies the drill so the trainee can see it first.
  function autopilot() {
    const s = drone; if (!run) return;
    if (mode !== 'loiter') setMode('loiter'); // demos are flown in Loiter
    let tx = s.x, ty = s.y, tz = 3.2, land = false, lead = 0.8;
    if (run.phase === 'hold') { tx = 0; ty = 0; tz = 3; }
    else if (run.phase === 'wp') ({ x: tx, y: ty, z: tz } = run.ex.targets[run.idx]);
    else if (run.phase === 'gates') { // line up 4 m in front of the gate, then fly straight through to 4 m past it
      const g = run.ex.gates[run.idx], nx = Math.sin(g.yaw), ny = Math.cos(g.yaw);
      if (run.gateFor !== run.idx) { run.gateFor = run.idx; run.gateStage = 'approach'; }
      const ap = { x: g.x - nx * 4, y: g.y - ny * 4 }, th = { x: g.x + nx * 4, y: g.y + ny * 4 };
      if (run.gateStage === 'approach' && Math.hypot(s.x - ap.x, s.y - ap.y) < 0.8) run.gateStage = 'through';
      ({ x: tx, y: ty } = run.gateStage === 'approach' ? ap : th); tz = 2.5;
    } else if (run.phase === 'land') { tx = 0; ty = 0; land = true; }
    else if (run.phase === 'done' || run.phase === 'free') { tz = s.z; land = true; }
    const lim = Math.min(4, prof.maxV * 0.8), vx = clamp((tx - s.x) * lead, -lim, lim), vy = clamp((ty - s.y) * lead, -lim, lim), sin = Math.sin(s.yaw), cos = Math.cos(s.yaw);
    sticks.pitch = clamp((vx * sin + vy * cos) / prof.maxV, -1, 1); sticks.roll = clamp((vx * cos - vy * sin) / prof.maxV, -1, 1); sticks.yaw = 0;
    sticks.thr = land ? (Math.hypot(tx - s.x, ty - s.y) < 0.6 ? -0.4 : 0) : clamp((tz - s.z) * 0.8, -1, 1);
  }

  // ---------- rendering ----------
  let view = 'pilot', camYaw = 0, camPitch = 0.15;
  function camera() {
    if (view === 'chase') return { C: { x: drone.x - Math.sin(drone.yaw) * 7, y: drone.y - Math.cos(drone.yaw) * 7, z: drone.z + 3 }, yaw: drone.yaw, pitch: 0.35 };
    if (view === 'top') return { C: { x: drone.x, y: drone.y - 0.01, z: drone.z + 32 }, yaw: 0, pitch: 1.5 };
    if (view === 'fpv') return { C: { x: drone.x, y: drone.y, z: drone.z + 0.1 }, yaw: drone.yaw, pitch: 0.08 };
    const C = { x: 0, y: -12, z: 1.7 }, dx = drone.x - C.x, dy = drone.y - C.y; // pilot stands behind the pad and turns to follow the drone
    let want = Math.atan2(dx, dy), d = want - camYaw; d = Math.atan2(Math.sin(d), Math.cos(d));
    camYaw += d * 0.08; camPitch += (clamp(-Math.atan2(drone.z - C.z, Math.hypot(dx, dy)) + 0.12, -0.8, 0.9) - camPitch) * 0.08;
    return { C, yaw: camYaw, pitch: camPitch };
  }
  function project(cam) {
    const c = Math.cos(cam.yaw), s = Math.sin(cam.yaw), cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch), F = cv.height;
    return (x, y, z) => {
      const dx = x - cam.C.x, dy = y - cam.C.y, dz = z - cam.C.z, rx = dx * c - dy * s, fh = dx * s + dy * c, depth = fh * cp - dz * sp;
      return depth < 0.2 ? null : [cv.width / 2 + F * rx / depth, cv.height / 2 - F * (fh * sp + dz * cp) / depth, depth];
    };
  }
  function draw() {
    const cam = camera(), P = project(cam), W = cv.width, H = cv.height, dpr = window.devicePixelRatio || 1;
    const hy = clamp(H / 2 - H * Math.tan(cam.pitch), -10, H + 10);
    const sky = ctx.createLinearGradient(0, 0, 0, Math.max(1, hy)); sky.addColorStop(0, '#7fb2e5'); sky.addColorStop(1, '#d6e8f7');
    ctx.fillStyle = sky; ctx.fillRect(0, 0, W, H); ctx.fillStyle = '#6a9a55'; ctx.fillRect(0, hy, W, H - hy);
    const seg = (a, b, col, w) => { if (a && b) { ctx.strokeStyle = col; ctx.lineWidth = w * dpr; ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke(); } };
    for (let g = -60; g <= 60; g += 5) for (let k = -60; k < 60; k += 5) { seg(P(g, k, 0), P(g, k + 5, 0), 'rgba(255,255,255,.18)', 1); seg(P(k, g, 0), P(k + 5, g, 0), 'rgba(255,255,255,.18)', 1); }
    const ring = (cx, cy, z, r, col, w, n = 32) => { for (let i = 0; i < n; i++) { const a = i / n * 6.283, b = (i + 1) / n * 6.283; seg(P(cx + r * Math.cos(a), cy + r * Math.sin(a), z), P(cx + r * Math.cos(b), cy + r * Math.sin(b), z), col, w); } };
    ring(0, 0, 0, FENCE, 'rgba(220,38,38,.7)', 2, 64);
    const pad = P(0, 0, 0);
    ring(0, 0, 0, PAD, '#f8fafc', 3); ring(0, 0, 0, PAD * 0.6, '#f8fafc', 2);
    if (pad) { ctx.fillStyle = '#f8fafc'; ctx.font = `bold ${clamp(H * 0.9 / pad[2], 8, 60)}px system-ui`; ctx.textAlign = 'center'; ctx.fillText('H', pad[0], pad[1] + 4); }
    if (run && run.ex.hold && run.phase !== 'done') { ring(0, 0, 2, PAD, 'rgba(251,191,36,.9)', 2); ring(0, 0, 4.5, PAD, 'rgba(251,191,36,.9)', 2); }
    const f = run && run.ex.field;
    if (f) { // crop field: rows, sprayed cells tinted blue
      const quad = (x0, y0, x1, y1, fill) => { const q = [P(x0, y0, 0), P(x1, y0, 0), P(x1, y1, 0), P(x0, y1, 0)]; if (q.some(v => !v)) return; ctx.fillStyle = fill; ctx.beginPath(); q.forEach((v, i) => ctx[i ? 'lineTo' : 'moveTo'](v[0], v[1])); ctx.fill(); };
      quad(f.x0, f.y0, f.x1, f.y1, 'rgba(101,163,13,.55)');
      for (let y = f.y0; y < f.y1; y++) for (let x = f.x0; x < f.x1; x++) if (run.cov[(y - f.y0) * (f.x1 - f.x0) + (x - f.x0)]) quad(x, y, x + 1, y + 1, 'rgba(56,189,248,.45)');
      for (let x = f.x0; x <= f.x1; x++) seg(P(x, f.y0, 0), P(x, f.y1, 0), 'rgba(63,98,18,.6)', 1);
    }
    if (run && run.ex.gates) run.ex.gates.forEach((g, i) => { // 3 × 3 m frames, next one highlighted
      const col = i < run.idx ? 'rgba(16,185,129,.9)' : i === run.idx && run.phase === 'gates' ? '#fbbf24' : 'rgba(255,255,255,.7)';
      const ux = Math.cos(g.yaw), uy = -Math.sin(g.yaw), c = [[-1.5, 1], [1.5, 1], [1.5, 4], [-1.5, 4]].map(([u, z]) => P(g.x + ux * u, g.y + uy * u, z));
      for (let k = 0; k < 4; k++) seg(c[k], c[(k + 1) % 4], col, 4);
      seg(P(g.x - ux * 1.5, g.y - uy * 1.5, 0), c[0], 'rgba(71,85,105,.9)', 2); seg(P(g.x + ux * 1.5, g.y + uy * 1.5, 0), c[1], 'rgba(71,85,105,.9)', 2);
    });
    if (run) run.ex.targets.forEach((w, i) => {
      const col = i < run.idx ? 'rgba(16,185,129,.8)' : i === run.idx && run.phase === 'wp' ? '#fbbf24' : 'rgba(255,255,255,.55)';
      seg(P(w.x, w.y, 0), P(w.x, w.y, w.z), col, 2); ring(w.x, w.y, w.z, 1.5, col, 3, 24);
    });
    const tr = replay ? replay.trace : run && showTrace ? run.trace : null; // flown path
    if (tr) for (let i = 1; i < tr.length; i++) seg(P(tr[i - 1][1], tr[i - 1][2], tr[i - 1][3]), P(tr[i][1], tr[i][2], tr[i][3]), 'rgba(14,165,233,.85)', 2);
    if (view === 'fpv') return hud(); // no airframe drawn from inside the cockpit
    // drone: shadow, arms, rotors (front = red)
    const s = drone, sin = Math.sin(s.yaw), cos = Math.cos(s.yaw), at = (f, r) => P(s.x + f * sin + r * cos, s.y + f * cos - r * sin, s.z);
    const sh = P(s.x, s.y, 0); if (sh) { ctx.fillStyle = 'rgba(0,0,0,.3)'; ctx.beginPath(); ctx.ellipse(sh[0], sh[1], clamp(H * 0.4 / sh[2], 2, 90), clamp(H * 0.15 / sh[2], 1, 40), 0, 0, 7); ctx.fill(); }
    const c0 = P(s.x, s.y, s.z);
    [[0.28, 0.28, '#ef4444'], [0.28, -0.28, '#ef4444'], [-0.28, 0.28, '#e2e8f0'], [-0.28, -0.28, '#e2e8f0']].forEach(([f, r, col]) => {
      const p = at(f, r); seg(c0, p, '#111827', 3);
      if (p) { ctx.strokeStyle = col; ctx.lineWidth = 2 * dpr; ctx.beginPath(); ctx.arc(p[0], p[1], clamp(H * 0.13 / p[2], 2, 60), 0, 7); ctx.stroke(); }
    });
    if (c0 && H / c0[2] < 12) { ctx.strokeStyle = 'rgba(251,191,36,.9)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(c0[0], c0[1], 10 * dpr, 0, 7); ctx.stroke(); } // halo when far away
    hud();
  }
  const fmt = t => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
  function hud() {
    const s = drone;
    $('hAlt').textContent = `${s.z.toFixed(1)} m`; $('hSpd').textContent = `${Math.hypot(s.vx, s.vy).toFixed(1)} m/s`;
    $('hHdg').textContent = `${Math.round(((s.yaw * 180 / Math.PI) % 360 + 360) % 360)}°`; $('hDist').textContent = `${Math.hypot(s.x, s.y).toFixed(1)} m`;
    $('hTime').textContent = run ? fmt(run.t) + (run.ex.limit ? ' / ' + fmt(run.ex.limit) : '') : '—';
    if (cfg.testId && testDeadline) $('hTime').textContent += ` · test ${fmt(Math.max(0, (testDeadline - Date.now()) / 1000))}`;
    const stickPos = (id, x, y) => { const d = $(id); d.style.left = `${50 + x * 40}%`; d.style.top = `${50 - y * 40}%`; };
    stickPos('stickL', sticks.yaw, sticks.thr); stickPos('stickR', sticks.roll, sticks.pitch);
    $('hMode').textContent = replay ? 'Replay' : s.auto ? { takeoff: 'Takeoff', rtl: 'RTL', land: 'Land' }[s.auto.type] : MODES[mode];
    $('hArm').textContent = s.crashed ? 'CRASHED' : s.armed ? 'ARMED' : 'Disarmed'; $('hArm').style.color = s.armed ? '#fca5a5' : '';
    $('hBat').textContent = `${Math.round(s.bat)}%`; $('hBat').style.color = s.bat <= 15 ? '#f87171' : s.bat <= 30 ? '#fbbf24' : '';
    $('hExtra').textContent = run && run.cov ? `Sprayed ${Math.round(coverage() * 100)}% (need 70%)` : run && run.ex.gates ? `Gate ${Math.min(run.idx + 1, run.ex.gates.length)} of ${run.ex.gates.length}` : '';
    if (run && run.phase === 'hold') $('instr').textContent = `${TEXT.hold} ${Math.min(10, run.holdT).toFixed(1)} / 10 s`;
    else if (run && run.phase === 'takeoff' && !s.armed && !demo) $('instr').textContent = TEXT.arm;
    if (performance.now() < noteUntil) $('instr').textContent = noteText;
  }
  function panel() {
    const r = run;
    $('exName').textContent = r ? r.ex.name + (demo ? ' — demo' : '') : 'Choose a drill';
    $('instr').textContent = !r ? 'Pick a drill, watch the demo, then fly it yourself.' : r.phase === 'done'
      ? (drone.crashed ? '💥 Crashed — descend slower than 2 m/s when landing.' : r.passed ? `✅ Passed in ${fmt(r.t)} (penalties ${Math.round(r.pen)} s).` : `❌ Not passed (${fmt(r.t)}, penalties ${Math.round(r.pen)} s).`)
      : r.phase === 'wp' ? `${TEXT.next} (marker ${r.idx + 1} of ${r.ex.targets.length}${r.idx === r.ex.targets.length - 1 ? ' — back over the pad' : ''})` : TEXT[r.phase];
    if (r && r.phase === 'done' && r.cov) $('instr').textContent += ` Field sprayed: ${Math.round(coverage() * 100)}%.`;
    document.querySelectorAll('[data-ex]').forEach(b => b.classList.toggle('pri', r && b.dataset.ex === r.key));
  }

  // ---------- loop + controls ----------
  function resize() { const dpr = window.devicePixelRatio || 1; cv.width = cv.clientWidth * dpr; cv.height = cv.clientHeight * dpr; }
  // Motor sound: a filtered sawtooth whose pitch follows the load (created on first use — browsers need a click first).
  let audio = null, showTrace = store.get('simTrace', true);
  function sound(on) {
    if (on && !audio && window.AudioContext) {
      const ac = new AudioContext(), o = ac.createOscillator(), fl = ac.createBiquadFilter(), g = ac.createGain();
      o.type = 'sawtooth'; fl.type = 'lowpass'; fl.frequency.value = 900; g.gain.value = 0; o.connect(fl).connect(g).connect(ac.destination); o.start(); audio = { ac, o, g };
    } else if (!on && audio) { audio.ac.close(); audio = null; }
  }
  function updateSound() {
    if (!audio) return;
    const s = drone, on = s.armed && !replay, load = 0.35 + 0.4 * Math.max(0, sticks.thr) + 0.05 * Math.hypot(s.vx, s.vy), t = audio.ac.currentTime;
    audio.o.frequency.setTargetAtTime(90 + 160 * load, t, 0.1); audio.g.gain.setTargetAtTime(on ? 0.05 : 0, t, 0.15);
  }
  function playReplay(dt) { // move a ghost along the recorded path; physics and scoring are paused
    const tr = replay.trace; replay.t += dt;
    let i = replay.i || 0; while (i < tr.length - 1 && tr[i + 1][0] <= replay.t) i++; replay.i = i;
    const [, x, y, z, yaw] = tr[i]; Object.assign(drone, { x, y, z, yaw, vx: 0, vy: 0, vz: 0 });
    if (replay.t > tr.at(-1)[0]) { replay = null; note('Replay finished — press Space or pick a drill to fly again.'); }
  }
  let last = 0, acc = 0;
  function frame(ts) {
    const dt = Math.min(0.1, last ? (ts - last) / 1000 : 0); last = ts; acc += dt;
    if (replay) { playReplay(dt); acc = 0; }
    else {
      readInputs(dt);
      while (acc >= 1 / 120) { physics(1 / 120); step(1 / 120); acc -= 1 / 120; }
    }
    if (cfg.testId && testDeadline && Date.now() > testDeadline && run && run.phase !== 'done') { // time's up: fail the rest, finish() submits
      queue.forEach(k => results.push({ exercise: k, passed: 0, seconds: 0, penalties: 0 })); queue = []; finish(false, 'fail');
    }
    updateSound(); draw(); requestAnimationFrame(frame);
  }
  document.querySelectorAll('[data-ex]').forEach(b => b.onclick = () => { demo = false; start(b.dataset.ex); });
  $('demoBtn').onclick = () => { demo = true; start(run && run.key !== 'free' ? run.key : 'hover'); };
  $('resetBtn').onclick = restart;
  $('viewSel').onchange = e => { view = e.target.value; };
  $('windChk').onchange = e => { windOn = e.target.checked; };
  document.querySelectorAll('[data-mode]').forEach(b => { b.onclick = () => setMode(b.dataset.mode); b.classList.toggle('pri', b.dataset.mode === mode); });
  $('armBtn').onclick = () => (drone.armed ? disarm() : arm());
  $('takeoffBtn').onclick = takeoff;
  $('rtlBtn').onclick = rtl;
  $('soundChk').onchange = e => sound(e.target.checked);
  $('traceChk').checked = showTrace; $('traceChk').onchange = e => { showTrace = e.target.checked; store.set('simTrace', showTrace); };
  $('replayBtn').onclick = () => { if (lastTrace) { demo = false; if (run) run.phase = 'done'; replay = { trace: lastTrace, t: 0, i: 0 }; } };
  $('profileSel').value = store.get('simProfile', 'trainer') in PROFILES ? store.get('simProfile', 'trainer') : 'trainer';
  $('profileSel').onchange = e => { prof = PROFILES[e.target.value] || PROFILES.trainer; store.set('simProfile', e.target.value); };
  $('calBtn').onclick = () => { // record the sticks' resting position as centre (fixes transmitters that read slightly off-centre)
    const gp = [...(navigator.getGamepads?.() || [])].find(Boolean);
    if (!gp) return note('Connect your transmitter / gamepad first.');
    axesCfg.center = gp.axes.map(a => +a.toFixed(3)); store.set('simAxes', axesCfg); note('Centre calibrated — leave the sticks centred while calibrating.');
  };
  // Speech voices load asynchronously; tell the user when their device has no voice for the chosen language.
  const voiceNote = () => {
    const vs = window.speechSynthesis ? speechSynthesis.getVoices() : [];
    $('voiceNote').textContent = !window.speechSynthesis ? 'This browser has no speech support.'
      : vs.length && !vs.some(v => v.lang.replace('_', '-').toLowerCase().startsWith(lang.slice(0, 2)))
        ? 'No voice for this language is installed on this device — add it in your OS language/speech settings, or pick another language.' : '';
  };
  if (window.speechSynthesis) speechSynthesis.onvoiceschanged = voiceNote;
  $('langSel').value = lang; $('langSel').onchange = e => { lang = e.target.value; store.set('simLang', lang); voiceNote(); say('hold'); };
  voiceNote();
  $('voiceChk').checked = voiceOn; $('voiceChk').onchange = e => { voiceOn = e.target.checked; store.set('simVoice', voiceOn); };
  // transmitter axis mapping (calibration knob)
  $('gpEnable').checked = axesCfg.enabled; $('gpEnable').onchange = e => { axesCfg.enabled = e.target.checked; store.set('simAxes', axesCfg); };
  for (const k of ['thr', 'yaw', 'pitch', 'roll']) {
    $('ax_' + k).value = axesCfg[k].axis; $('inv_' + k).checked = axesCfg[k].inv;
    $('ax_' + k).onchange = e => { axesCfg[k].axis = +e.target.value; store.set('simAxes', axesCfg); };
    $('inv_' + k).onchange = e => { axesCfg[k].inv = e.target.checked; store.set('simAxes', axesCfg); };
  }
  if (cfg.testId) $('testBtn').onclick = () => {
    if (!confirm('Start the simulator test? You will fly all three drills back to back within 15 minutes. You cannot restart once started.')) return;
    demo = false; results = []; queue = ['square', 'eight']; testDeadline = Date.now() + 15 * 60 * 1000;
    document.querySelectorAll('[data-ex],#demoBtn,#resetBtn,#testBtn').forEach(b => { b.disabled = true; });
    start('hover');
  };
  addEventListener('resize', resize);
  reset(); resize(); panel(); requestAnimationFrame(frame);
})();

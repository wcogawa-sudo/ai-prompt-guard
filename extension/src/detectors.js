// Detectors: find sensitive data in a string. Pure functions, no browser APIs,
// so the same file runs in the content script and in Node tests.
//
// Each detection: { type, start, end, value, confidence }
// `start`/`end` are character offsets into the scanned text.

(function (root) {
  "use strict";

  // ---------- helpers ----------

  function luhnValid(digits) {
    let sum = 0;
    let double = false;
    for (let i = digits.length - 1; i >= 0; i--) {
      let d = digits.charCodeAt(i) - 48;
      if (double) {
        d *= 2;
        if (d > 9) d -= 9;
      }
      sum += d;
      double = !double;
    }
    return sum % 10 === 0;
  }

  function isValidDate(year, month, day) {
    if (month < 1 || month > 12 || day < 1) return false;
    const dim = [31, (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)) ? 29 : 28,
      31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    return day <= dim[month - 1];
  }

  // Run a global regex over text and yield matches with offsets.
  function* matches(re, text) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      yield m;
      if (m[0].length === 0) re.lastIndex++;
    }
  }

  // ---------- SA ID number ----------
  // Format: YYMMDD SSSS C A Z
  //   YYMMDD = date of birth, SSSS = gender sequence,
  //   C = citizenship (0 citizen, 1 permanent resident, 2 refugee),
  //   A = historically race, now usually 8/9, Z = Luhn check digit.
  // Accepts contiguous 13 digits or the common "YYMMDD SSSS CAZ" spacing.
  const SA_ID_RE = /(?<![\d])(\d{6})[ -]?(\d{4})[ -]?(\d{3})(?![\d])/g;

  function saIdNumbers(text) {
    const out = [];
    for (const m of matches(SA_ID_RE, text)) {
      const digits = m[1] + m[2] + m[3];
      const yy = +digits.slice(0, 2);
      const mm = +digits.slice(2, 4);
      const dd = +digits.slice(4, 6);
      const citizenship = digits[10];
      // Century is ambiguous, so accept the date if it's valid in either.
      const dateOk = isValidDate(1900 + yy, mm, dd) || isValidDate(2000 + yy, mm, dd);
      const valid = dateOk && "012".includes(citizenship) && luhnValid(digits);
      // A 13-digit number that fails the checks may still be an ID with a typo:
      // report it as a lower-confidence "possible" ID instead of ignoring it.
      out.push({ type: "SA_ID_NUMBER", start: m.index, end: m.index + m[0].length, value: m[0],
        confidence: valid ? 0.99 : dateOk ? 0.75 : 0.6, possible: !valid });
    }
    return out;
  }

  // ---------- Payment card ----------
  const CARD_RE = /(?<![\d])(?:\d[ -]?){12,18}\d(?![\d])/g;
  const CARD_PREFIXES = [
    /^4/, // Visa
    /^5[1-5]/, /^2(2[2-9][1-9]|2[3-9]\d|[3-6]\d\d|7[01]\d|720)/, // Mastercard
    /^3[47]/, // Amex
    /^6(011|5)/, // Discover
    /^35(2[89]|[3-8]\d)/, // JCB
    /^3(0[0-5]|[68])/, // Diners
  ];

  function paymentCards(text) {
    const out = [];
    for (const m of matches(CARD_RE, text)) {
      const digits = m[0].replace(/[ -]/g, "");
      if (digits.length < 13 || digits.length > 19) continue;
      if (!CARD_PREFIXES.some((p) => p.test(digits))) continue;
      if (!luhnValid(digits)) {
        // Looks like a card (4 groups of 4) but fails the checksum: possible card.
        if (/^\d{4}([ -])\d{4}\1\d{4}\1\d{4}$/.test(m[0])) {
          out.push({ type: "CREDIT_CARD", start: m.index, end: m.index + m[0].length, value: m[0], confidence: 0.7, possible: true });
        }
        continue;
      }
      out.push({ type: "CREDIT_CARD", start: m.index, end: m.index + m[0].length, value: m[0], confidence: 0.95 });
    }
    return out;
  }

  // ---------- Email ----------
  // Only start at the beginning of a run (lookbehind) and bound every part,
  // so a long run of letters/digits without "@" is scanned once, not once per
  // position (that was quadratic: 50 KB took ~1.2 s).
  const EMAIL_RE = /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,8}\.[A-Za-z]{2,24}(?![A-Za-z0-9-])/g;

  function emails(text) {
    const out = [];
    for (const m of matches(EMAIL_RE, text)) {
      out.push({ type: "EMAIL", start: m.index, end: m.index + m[0].length, value: m[0], confidence: 0.98 });
    }
    return out;
  }

  // ---------- SA phone number ----------
  // +27 / 0027 / 0 prefix, then a 9-digit national number starting 1-8.
  // Allows spaces, dashes and brackets: 082 123 4567, +27 (0)82-123-4567, 0821234567
  const PHONE_RE = /(?<![\d+])(?:\+27|0027|0)[ -]?(?:\(0\)[ -]?)?[1-8]\d(?:[ -]?\d){7}(?![\d])/g;

  function saPhones(text) {
    const out = [];
    for (const m of matches(PHONE_RE, text)) {
      out.push({ type: "PHONE_NUMBER", start: m.index, end: m.index + m[0].length, value: m[0], confidence: 0.85 });
    }
    return out;
  }

  // ---------- Secrets / API keys ----------
  const SECRET_PATTERNS = [
    { re: /sk-ant-[A-Za-z0-9_-]{20,}/g, confidence: 0.99 },            // Anthropic
    { re: /sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}/g, confidence: 0.95 }, // OpenAI
    { re: /AKIA[0-9A-Z]{16}/g, confidence: 0.99 },                       // AWS access key ID
    { re: /gh[pousr]_[A-Za-z0-9]{36,}/g, confidence: 0.99 },             // GitHub tokens
    { re: /github_pat_[A-Za-z0-9_]{50,}/g, confidence: 0.99 },
    { re: /glpat-[A-Za-z0-9_-]{20,}/g, confidence: 0.99 },               // GitLab
    { re: /xox[abposr]-[A-Za-z0-9-]{10,}/g, confidence: 0.99 },          // Slack
    { re: /AIza[0-9A-Za-z_-]{35}/g, confidence: 0.95 },                  // Google API key
    { re: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z]+ )?PRIVATE KEY-----|$)/g, confidence: 0.99 },
    { re: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, confidence: 0.9 }, // JWT
  ];
  // "password = hunter2" style assignments: only the value is flagged.
  const ASSIGNMENT_RE = /\b(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)\b\s*[:=]\s*["']?(?!\[[A-Z_]+_\d+\])([^\s"']{6,})/gi; // not our own placeholders

  function secrets(text) {
    const out = [];
    for (const { re, confidence } of SECRET_PATTERNS) {
      for (const m of matches(re, text)) {
        out.push({ type: "API_SECRET", start: m.index, end: m.index + m[0].length, value: m[0], confidence });
      }
    }
    for (const m of matches(ASSIGNMENT_RE, text)) {
      const valueStart = m.index + m[0].length - m[1].length;
      out.push({ type: "API_SECRET", start: valueStart, end: valueStart + m[1].length, value: m[1], confidence: 0.8 });
    }
    return out;
  }

  // ---------- Admin keywords ----------
  function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function keywords(text, values) {
    const out = [];
    for (const v of values || []) {
      if (!v || !v.trim()) continue;
      const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(v.trim())}(?![\\p{L}\\p{N}])`, "giu");
      for (const m of matches(re, text)) {
        out.push({ type: "KEYWORD", start: m.index, end: m.index + m[0].length, value: m[0], confidence: 1 });
      }
    }
    return out;
  }


  // ---------- context-aware numbers ----------
  // A number right after words that say what it is ("credit card", "passport",
  // "account no") is flagged as that type even if its format isn't valid.
  // This catches "here is my credit card number 557388210".
  const CONTEXT_RULES = [
    { type: "CREDIT_CARD", words: "credit card|debit card|card number|card no|card num|cc number|cc no|cvv|cvc|card" },
    { type: "SA_ID_NUMBER", words: "id number|id no|id num|identity number|identity no|i\\.?d\\.?|id" },
    { type: "PASSPORT", words: "passport number|passport no|passport" },
    { type: "BANK_ACCOUNT", words: "account number|account no|acc number|acc no|acct|account|bank account|branch code|iban|swift" },
    { type: "TAX_NUMBER", words: "tax number|tax no|tax reference|income tax|sars|vat number|vat no|tax" },
    { type: "MEMBER_NUMBER", words: "medical aid number|medical aid no|medical aid|member number|member no|membership number|policy number|policy no|patient number|employee number|staff number|student number|licen[cs]e number|licen[cs]e no" },
  ];
  // keyword, up to ~25 non-digit chars ("number is:", "#", "no."), then the number.
  const CONTEXT_RES = CONTEXT_RULES.map((r) => ({
    type: r.type,
    re: new RegExp(`\\b(?:${r.words})\\b[^\\d\\n]{0,25}?((?:\\d[ -]?){5,24}\\d)(?![\\d])`, "gi"),
  }));

  function contextNumbers(text) {
    const out = [];
    for (const { type, re } of CONTEXT_RES) {
      for (const m of matches(re, text)) {
        let start = m.index + m[0].length - m[1].length;
        // Include a short letter prefix attached to the number (passport "A12345678").
        let k = start;
        while (k > 0 && start - k < 3 && /[A-Za-z]/.test(text[k - 1])) k--;
        if (k < start && (k === 0 || !/[A-Za-z]/.test(text[k - 1]))) start = k;
        // 0.9: the user said what it is, so this beats a format-only guess (e.g. phone).
        const end = m.index + m[0].length;
        out.push({ type, start, end, value: text.slice(start, end), confidence: 0.9, possible: true });
      }
    }
    return out;
  }

  // ---------- passports ----------
  // SA passports: a letter + 8 digits (e.g. A12345678). Many foreign ones are
  // similar. Without the word "passport" nearby this is only a guess.
  const PASSPORT_RE = /(?<![A-Za-z0-9])([A-Z]\d{8}|[A-Z]{2}\d{7})(?![A-Za-z0-9])/g;
  function passports(text) {
    const out = [];
    for (const m of matches(PASSPORT_RE, text)) {
      out.push({ type: "PASSPORT", start: m.index, end: m.index + m[0].length, value: m[0], confidence: 0.6, possible: true });
    }
    return out;
  }

  // ---------- dates of birth ----------
  const DATE = String.raw`(?:\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/. ]\d{1,2}[-/. ]\d{2,4}|\d{1,2} (?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]* \d{2,4})`;
  const DOB_RE = new RegExp(String.raw`\b(?:born(?: on)?|dob|d\.o\.b\.?|date of birth|birthday|birth date)\b[^\d\n]{0,15}?(${DATE})`, "gi");
  function datesOfBirth(text) {
    const out = [];
    for (const m of matches(DOB_RE, text)) {
      const start = m.index + m[0].length - m[1].length;
      out.push({ type: "DATE_OF_BIRTH", start, end: start + m[1].length, value: m[1], confidence: 0.85, possible: true });
    }
    return out;
  }

  // ---------- IP addresses ----------
  const IPV4_RE = /(?<![\d.])(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?!\d|\.\d)/g; // a sentence's full stop may follow
  function ipAddresses(text) {
    const out = [];
    for (const m of matches(IPV4_RE, text)) {
      out.push({ type: "IP_ADDRESS", start: m.index, end: m.index + m[0].length, value: m[0], confidence: 0.9 });
    }
    return out;
  }

  // ---------- street addresses ----------
  const STREET_TYPES = "street|st|road|rd|avenue|ave|drive|dr|lane|ln|crescent|cres|close|cl|way|boulevard|blvd|place|pl|court|ct|circle|terrace|highway|hwy";
  const ADDRESS_RE = new RegExp(
    String.raw`\b(?:(?:unit|flat|apt)\s*\d+[a-z]?,?\s*)?\d{1,5}[a-z]?\s+(?:[A-Za-z'-]+\s+){1,3}(?:${STREET_TYPES})\b\.?(?:,\s*[A-Za-z' -]{2,30}){0,3}(?:,?\s*\d{4})?`, "gi");
  const POBOX_RE = /\b(?:p\.?\s?o\.?\s?box|private bag)\s*\d+(?:,\s*[A-Za-z' -]{2,30}){0,2}(?:,?\s*\d{4})?/gi;
  function addresses(text) {
    const out = [];
    for (const re of [ADDRESS_RE, POBOX_RE]) {
      for (const m of matches(re, text)) {
        out.push({ type: "ADDRESS", start: m.index, end: m.index + m[0].length, value: m[0].replace(/[,\s]+$/, ""), confidence: 0.8, possible: true });
      }
    }
    return out;
  }

  // ---------- long numbers ----------
  // Any standalone number of 9+ digits that nothing else claimed. Often an
  // account, reference or ID. Lowest priority; orgs can allow-list formats.
  const LONG_NUMBER_RE = /(?<![\d.])\d(?:[ -]?\d){8,}(?![\d])/g;
  function longNumbers(text) {
    const out = [];
    for (const m of matches(LONG_NUMBER_RE, text)) {
      out.push({ type: "LONG_NUMBER", start: m.index, end: m.index + m[0].length, value: m[0], confidence: 0.6, possible: true });
    }
    return out;
  }

  // ---------- person names ----------
  // Dictionary-based so it also works in lowercase ("thabo mokena"), plus cues
  // like "my name is" / "Mr" / "client". Not perfect: unknown names written in
  // lowercase without a cue are missed.
  const NAMES = (root.PG && root.PG.names) ||
    (typeof require === "function" ? require("./names.js") : { first: new Set(), last: new Set(), ambiguous: new Set() });
  // Everyday English words (words.js). Empty set = list missing: the
  // "unfamiliar word" rules below then never fire, rather than firing on everything.
  const WORDS = (root.PG && root.PG.words) ||
    (typeof require === "function" ? require("./words.js") : new Set());
  const WORD_RE = /[A-Za-z][A-Za-z'-]*/g;
  const CUE_RE = /\b(?:my name is|name is|name:|i am|i'm|this is|mr|mrs|ms|miss|dr|prof|client|customer|patient|employee|tenant|applicant|candidate|learner|student|colleague|manager|mother|father|son|daughter|wife|husband|brother|sister)\.?\s*$/i;
  const SURNAME_PARTICLE = new Set(["van", "der", "du", "de", "le", "den", "janse"]);
  // Titles and cue words are hints, never part of the name itself.
  const NOT_A_NAME = new Set(["mr", "mrs", "ms", "miss", "dr", "prof", "sir", "madam", "client", "customer",
    "patient", "employee", "tenant", "applicant", "candidate", "learner", "student", "colleague", "manager",
    "dear", "hi", "hello", "hey", "regards", "thanks", "from", "to", "cc", "the", "a", "an", "i", "my", "name",
    // common function words: never the start of a name
    "in", "on", "at", "of", "by", "for", "with", "and", "or", "but", "is", "was", "are", "were", "be", "as",
    "if", "so", "it", "its", "this", "that", "these", "those", "he", "she", "we", "they", "you", "me", "him",
    "her", "us", "them", "our", "your", "their", "his", "who", "what", "when", "where", "why", "how", "does",
    "did", "do", "has", "have", "had", "can", "will", "would", "should", "could", "about", "into", "than",
    "then", "not", "no", "yes", "all", "any", "some", "made", "make", "ask", "tell", "call", "email", "speak"]);

  // people: optional org list { names: ["George de Lange"], first_names: [], last_names: [] }
  // (e.g. exported from Active Directory / HR). Org names are always caught.
  function personNames(text, people) {
    const org = people || {};
    const orgFirst = new Set((org.first_names || []).map((x) => x.toLowerCase()));
    const orgLast = new Set((org.last_names || []).map((x) => x.toLowerCase()));
    for (const full of org.names || []) {
      const parts = full.toLowerCase().split(/\s+/).filter(Boolean);
      if (parts.length > 1) { orgFirst.add(parts[0]); orgLast.add(parts[parts.length - 1]); }
    }
    const words = [];
    for (const m of matches(WORD_RE, text)) words.push({ w: m[0], lw: m[0].toLowerCase(), start: m.index, end: m.index + m[0].length });
    const isCap = (t) => /^[A-Z][a-z]/.test(t.w);
    const isFirst = (t) => NAMES.first.has(t.lw) || orgFirst.has(t.lw);
    const isLast = (t) => NAMES.last.has(t.lw) || orgLast.has(t.lw);
    const isAmbiguous = (t) => NAMES.ambiguous.has(t.lw);
    // Unfamiliar = not an everyday English word, so after a first name it is
    // probably a surname ("william okafor" vs "william tomorrow"). Skips acronyms
    // (AWS), camelCase/tech tokens (useState) and very short words.
    // allowCaps: a form in capitals ("WILLIAM OKAFOR") where the first name is in capitals too.
    const isUnfamiliar = (t, allowCaps) => WORDS.size > 0 && t.w.length >= 3 && !WORDS.has(t.lw) &&
      !NOT_A_NAME.has(t.lw) && !SURNAME_PARTICLE.has(t.lw) &&
      (/^[A-Za-z][a-z'-]+$/.test(t.w) || (allowCaps && /^[A-Z'-]+$/.test(t.w))) && !/^[a-z]+[A-Z]/.test(t.w);
    const out = [];
    // Exact org names first (any case, any spacing), highest confidence.
    for (const full of org.names || []) {
      const re = new RegExp(`(?<![\\p{L}])${full.trim().split(/\s+/).map(escapeRe).join("\\s+")}(?![\\p{L}])`, "giu");
      for (const m of matches(re, text)) {
        out.push({ type: "PERSON_NAME", start: m.index, end: m.index + m[0].length, value: m[0], confidence: 1 });
      }
    }
    for (let i = 0; i < words.length; i++) {
      const a = words[i];
      // Ambiguous names that are also function words ("will") get a chance below
      // when a surname or cue backs them up.
      if (NOT_A_NAME.has(a.lw) && !isAmbiguous(a)) continue;
      // A surname that starts with a particle: "Mr de Lange", "Ms van Wyk".
      if (SURNAME_PARTICLE.has(a.lw)) {
        let k = i;
        while (k + 1 < words.length && k - i < 3 && SURNAME_PARTICLE.has(words[k + 1].lw) && /^\s+$/.test(text.slice(words[k].end, words[k + 1].start))) k++;
        const b = words[k + 1];
        const cueBefore = CUE_RE.test(text.slice(Math.max(0, a.start - 25), a.start));
        if (b && /^\s+$/.test(text.slice(words[k].end, b.start)) && !NOT_A_NAME.has(b.lw) &&
          ((cueBefore && (isCap(b) || isLast(b))) || (isCap(b) && isLast(b)))) {
          out.push({ type: "PERSON_NAME", start: a.start, end: b.end, value: text.slice(a.start, b.end), confidence: cueBefore ? 0.85 : 0.75, possible: true });
          i = k + 1;
        }
        continue;
      }
      // extend over surname particles: "Johan van der Merwe"
      let j = i + 1;
      // At most 3 particles ("janse van der"): unbounded, "van van van..." was quadratic.
      while (j < words.length && j - i <= 3 && SURNAME_PARTICLE.has(words[j].lw) && /^\s+$/.test(text.slice(words[j - 1].end, words[j].start))) j++;
      const b = words[j];
      const adjacent = b && /^\s+$/.test(text.slice(words[j - 1].end, b.start));
      const cue = CUE_RE.test(text.slice(Math.max(0, a.start - 25), a.start));

      let conf = 0;
      let end = a.end;
      const hasParticle = j > i + 1; // "x de lange", "x van wyk"
      if (adjacent && isFirst(a) && (isLast(b) || isCap(b)) && !NOT_A_NAME.has(b.lw)) { conf = isLast(b) ? 0.9 : 0.8; end = b.end; }
      // Known first name + unfamiliar word, any case: "william okafor".
      else if (adjacent && isFirst(a) && !isAmbiguous(a) && isUnfamiliar(b, /^[A-Z]{2,}$/.test(a.w))) { conf = 0.8; end = b.end; }
      // Ambiguous first name ("Will", "Grace") needs both capitalised + unfamiliar: "Will Okafor".
      else if (adjacent && isAmbiguous(a) && isCap(a) && isCap(b) && (isUnfamiliar(b) || isLast(b))) { conf = 0.75; end = b.end; }
      // A cue makes even an ambiguous lowercase name count: "my name is will okafor".
      else if (adjacent && cue && isAmbiguous(a) && (isUnfamiliar(b) || isLast(b) || isCap(b))) { conf = 0.85; end = b.end; }
      // Surname particles almost always mean a name, even for unknown names,
      // as long as one side looks like a name (avoids "delivery van driver").
      else if (adjacent && hasParticle && !NOT_A_NAME.has(b.lw) &&
        (isFirst(a) || isCap(a) || isLast(b) || isCap(b))) { conf = 0.8; end = b.end; }
      else if (adjacent && isCap(a) && isLast(b) && !NAMES.ambiguous.has(a.lw)) { conf = 0.75; end = b.end; }
      else if (adjacent && cue && (isCap(a) || isFirst(a)) && (isCap(b) || isLast(b))) { conf = 0.85; end = b.end; }
      else if (cue && (isFirst(a) || isCap(a))) { conf = 0.8; }
      else if (isFirst(a) && !NAMES.ambiguous.has(a.lw)) { conf = 0.6; }
      else if (isLast(a) && isCap(a) && !NAMES.ambiguous.has(a.lw) && a.w.length > 3) { conf = 0.55; }

      if (conf) {
        out.push({ type: "PERSON_NAME", start: a.start, end, value: text.slice(a.start, end), confidence: conf, possible: true });
        if (end > a.end) i = j; // skip the surname we consumed
      }
    }
    return out;
  }

  // ---------- overlap resolution ----------
  // Higher priority wins when two detections overlap (e.g. a 13-digit SA ID
  // that also passes as a card number, or a phone number inside an ID).
  const PRIORITY = {
    API_SECRET: 9,
    KEYWORD: 8,
    EMAIL: 7,
    SA_ID_NUMBER: 6,
    CREDIT_CARD: 5,
    PASSPORT: 4,
    BANK_ACCOUNT: 4,
    TAX_NUMBER: 4,
    MEMBER_NUMBER: 4,
    DATE_OF_BIRTH: 4,
    IP_ADDRESS: 4,
    PHONE_NUMBER: 3,
    ADDRESS: 2,
    PERSON_NAME: 1,
    LONG_NUMBER: 0,
  };

  // Most confident wins; then type priority; then longer match.
  function resolveOverlaps(dets) {
    const sorted = dets.slice().sort((a, b) =>
      b.confidence - a.confidence ||
      (PRIORITY[b.type] || 0) - (PRIORITY[a.type] || 0) ||
      (b.end - b.start) - (a.end - a.start) ||
      a.start - b.start);
    // Mark claimed characters instead of comparing every pair (that was
    // quadratic in the number of detections: 16k names took ~350 ms).
    const end = sorted.reduce((m, d) => Math.max(m, d.end), 0);
    const taken = new Uint8Array(end);
    const kept = [];
    for (const d of sorted) {
      let free = true;
      for (let i = d.start; i < d.end; i++) if (taken[i]) { free = false; break; }
      if (!free) continue;
      taken.fill(1, d.start, d.end);
      kept.push(d);
    }
    return kept.sort((a, b) => a.start - b.start);
  }

  // ---------- public ----------
  // options.keywords: admin keyword list (strings)
  function detect(text, options) {
    if (!text) return [];
    const opts = options || {};
    const all = [
      ...secrets(text),
      ...keywords(text, opts.keywords),
      ...saIdNumbers(text),
      ...paymentCards(text),
      ...emails(text),
      ...saPhones(text),
      ...contextNumbers(text),
      ...passports(text),
      ...datesOfBirth(text),
      ...ipAddresses(text),
      ...addresses(text),
      ...personNames(text, opts.people),
      ...longNumbers(text),
    ];
    return resolveOverlaps(all);
  }

  const api = { detect, luhnValid, _internal: { saIdNumbers, paymentCards, emails, saPhones, secrets, keywords,
  contextNumbers, passports, datesOfBirth, ipAddresses, addresses, personNames, longNumbers } };
  root.PG = root.PG || {};
  root.PG.detectors = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);

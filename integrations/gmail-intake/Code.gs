/**
 * WazzOCR — Gmail email channel
 * ---------------------------------------------------------------------------
 * Runs inside the account's own Gmail (e.g. ayuborneowazzocr@gmail.com) on a
 * time trigger. Every PDF or photo that arrives is sent to WazzOCR, which reads
 * it with the same AI as WhatsApp and creates the draft bill in Xero. Results
 * show in WazzOCR → Email tab. Bills whose Xero organisation is unclear go to
 * Unmatched, and WazzOCR asks the WhatsApp number set in Settings → Email
 * channel to pick one.
 *
 * Same method as Signum Unidash's Gmail intake: this script only delivers files.
 * WazzOCR answers straight away and processes in the background, so a slow AI
 * read never hits Apps Script's time limit.
 *
 * DRIVE COPY: every bill file WazzOCR receives (email or WhatsApp, created,
 * duplicate, needing review or failed) is also saved to THIS Gmail's Drive
 * under WazzOCR Bills / <month> / <result>. WazzOCR keeps each file until this
 * script collects it, a few per run. Needs Drive permission: run `setup` once.
 *
 * ANYONE can email the mailbox — there is no sender list. Emails with no PDF or
 * photo are still reported, so they show in the Email tab as "nothing to bill".
 *
 * DEDUPE: every attachment WazzOCR accepted is recorded in Script Properties by
 * (message id + size + name) and never sent twice. A network or server error is
 * not recorded, so it is retried on the next run. WazzOCR ignores a repeat of
 * the same file too, so a retry can never create a second bill.
 *
 * ONE-TIME SETUP (signed in as the mailbox's Gmail account):
 *   1. script.google.com → New project → paste this whole file → Save.
 *      (Download it from WazzOCR → Settings → Email channel: the address and
 *      API key below are filled in for you.)
 *   2. Run `setup` once and allow the permissions.
 *   3. Run `seedProcessed` once if the mailbox already has old emails you do NOT
 *      want sent (marks them done). Skip it to send everything from the last
 *      SCAN_DAYS days.
 *   4. Run `installTrigger` once (checks the mailbox every minute).
 *   Use `run` to test by hand. Logs: Executions in the left menu.
 */

/**
 * Bumped whenever this file changes in a way that matters. Sent on every
 * heartbeat so WazzOCR's Settings card can say whether the pasted copy is
 * current. Keep identical to EXPECTED_SCRIPT_VERSION in lib/emailIntake.js.
 */
var SCRIPT_VERSION = '2026-11-10c';

var CONFIG = {
  WAZZOCR_API_BASE: '__WAZZOCR_API_BASE__',   // e.g. https://wazzocr.fusioneta.com.my (no trailing slash)
  WAZZOCR_API_KEY:  '__WAZZOCR_API_KEY__',    // the account's API key

  // Leave '' to scan the whole inbox (right for a mailbox used only for bills).
  // Set a label name to only send emails a Gmail filter put under that label.
  SOURCE_LABEL:    '',
  PROCESSED_LABEL: 'wazzocr-processed',
  ERROR_LABEL:     'wazzocr-error',

  ALLOWED_EXT: ['pdf', 'jpg', 'jpeg', 'png', 'heic', 'heif', 'webp'],
  // WazzOCR accepts requests up to 20 MB; base64 adds a third, so files above
  // this are reported as too large instead of being sent.
  MAX_BYTES: 14 * 1024 * 1024,
  MAX_THREADS_PER_RUN: 20,
  SCAN_DAYS: 3,               // only threads active in the last N days (Gmail quota saver)

  // Every bill file WazzOCR receives (email or WhatsApp, whatever the result)
  // is saved to this Gmail's Drive under DRIVE_ROOT / <month> / <result>.
  DRIVE_ROOT: 'WazzOCR Bills',
};

/**
 * Entry point for the time trigger. Times itself so WazzOCR can show how much of
 * Google's daily trigger allowance (90 min/day on a free Gmail) is being used:
 * each run reports the PREVIOUS run's duration on its heartbeat.
 */
function run() {
  var started = Date.now();
  try {
    run_();
  } finally {
    var props = PropertiesService.getScriptProperties();
    props.setProperty('lastRunMs', String(Date.now() - started));
    props.setProperty('lastRunAt', new Date(started).toISOString());
  }
}

function run_() {
  ensureLabels_();
  var processed = GmailApp.getUserLabelByName(CONFIG.PROCESSED_LABEL);
  var errored   = GmailApp.getUserLabelByName(CONFIG.ERROR_LABEL);
  var props     = PropertiesService.getScriptProperties();

  var hb = heartbeat_();                 // liveness, even on quiet minutes
  if (hb && hb.enabled === false) {      // turned off in WazzOCR Settings
    Logger.log('Email channel is switched off in WazzOCR — nothing sent.');
    return;
  }

  var threads = GmailApp.search(searchQuery_(), 0, CONFIG.MAX_THREADS_PER_RUN);
  if (threads.length) Logger.log('Scanning %s thread(s)', threads.length);

  threads.forEach(function (thread) {
    var anyFailed = false;
    thread.getMessages().forEach(function (msg) {
      var real = msg.getAttachments({ includeInlineImages: false });
      var sendable = real.filter(isForwardable_);

      if (!sendable.length) {
        var mkey = 'msg_' + msg.getId();
        if (props.getProperty(mkey)) return;
        var tooBig = real.filter(function (a) { return isAllowedType_(a) && a.getSize() > CONFIG.MAX_BYTES; });
        var reason = tooBig.length
          ? 'Too large to send (over 14 MB): ' + names_(tooBig) + '.'
          : real.length
            ? 'No PDF or photo attached (' + names_(real) + ').'
            : 'No attachment.';
        var r = post_('/api/email/intake', meta_(msg, { skipped: true, reason: reason }));
        if (r.code === 200) props.setProperty(mkey, String(Date.now()));
        else anyFailed = true;
        return;
      }

      sendable.forEach(function (att) {
        var key = 'att_' + msg.getId() + '_' + att.getSize() + '_' + (att.getName() || '');
        if (props.getProperty(key)) return;
        try {
          var r = post_('/api/email/intake', meta_(msg, {
            fileName:   att.getName() || 'attachment',
            mimeType:   att.getContentType(),
            fileBase64: Utilities.base64Encode(att.getBytes()),
          }));
          // 200/202 = WazzOCR has it (queued, already received, or not a bill type).
          if (r.code === 200 || r.code === 202) props.setProperty(key, String(Date.now()));
          else { anyFailed = true; Logger.log('"%s" → HTTP %s %s', att.getName(), r.code, r.raw.slice(0, 200)); }
        } catch (err) {
          anyFailed = true;
          Logger.log('Send failed for "%s": %s', att.getName(), err);
        }
      });
    });
    if (anyFailed) {
      thread.addLabel(errored);
    } else {
      thread.addLabel(processed);
      thread.removeLabel(errored);
    }
  });

  // Save waiting bill files to Drive. A Drive problem never stops intake.
  if (hb && hb.archiveWaiting > 0) {
    try { archiveToDrive_(); }
    catch (err) { Logger.log('Drive archive failed: %s', err); }
  }
}

/**
 * Collect up to 5 waiting bill files from WazzOCR and save each to
 * DRIVE_ROOT / 2026-11 / Created | Needs review | Duplicate | Failed.
 * WazzOCR deletes its copy once told the file is in Drive; anything not
 * confirmed is offered again next run.
 */
function archiveToDrive_() {
  var list = get_('/api/email/archive');
  if (list.code !== 200) { Logger.log('Archive list → HTTP %s', list.code); return; }
  var items = (JSON.parse(list.raw) || {}).items || [];
  items.forEach(function (it) {
    var file = get_('/api/email/archive/' + it.id + '/file');
    if (file.code !== 200) { Logger.log('Archive file %s → HTTP %s', it.id, file.code); return; }
    var folder = folderPath_([CONFIG.DRIVE_ROOT, it.month, it.folder]);
    var saved = folder.createFile(file.blob.setName(it.name).setContentType(it.mime));
    var done = post_('/api/email/archive/' + it.id + '/done', { driveFileId: saved.getId() });
    Logger.log('Saved to Drive: %s/%s/%s → HTTP %s', it.month, it.folder, it.name, done.code);
  });
}

/** GET with the API key. Returns { code, raw, blob }. */
function get_(path) {
  var res = UrlFetchApp.fetch(CONFIG.WAZZOCR_API_BASE + path, {
    method: 'get', muteHttpExceptions: true, headers: { 'X-Api-Key': CONFIG.WAZZOCR_API_KEY },
  });
  return { code: res.getResponseCode(), raw: res.getContentText(), blob: res.getBlob() };
}

/**
 * Find or create nested folders from My Drive. The root folder's id is kept so
 * renaming or moving it in Drive does not create a second one.
 */
function folderPath_(names) {
  var props = PropertiesService.getScriptProperties();
  var root = null;
  var rootId = props.getProperty('driveRootId');
  if (rootId) { try { root = DriveApp.getFolderById(rootId); if (root.isTrashed()) root = null; } catch (e) { root = null; } }
  if (!root) {
    var found = DriveApp.getRootFolder().getFoldersByName(names[0]);
    root = found.hasNext() ? found.next() : DriveApp.getRootFolder().createFolder(names[0]);
    props.setProperty('driveRootId', root.getId());
  }
  var folder = root;
  for (var i = 1; i < names.length; i++) {
    var sub = folder.getFoldersByName(names[i]);
    folder = sub.hasNext() ? sub.next() : folder.createFolder(names[i]);
  }
  return folder;
}

/**
 * No has:attachment term on purpose: an email with nothing to send still shows
 * in WazzOCR's Email tab, saying why. A later reply in a processed thread is still picked
 * up, because the per-message records — not the label — decide what was sent.
 */
function searchQuery_() {
  var scope = CONFIG.SOURCE_LABEL ? 'label:' + CONFIG.SOURCE_LABEL : 'in:inbox';
  return scope + ' newer_than:' + CONFIG.SCAN_DAYS + 'd';
}

function isAllowedType_(att) {
  var name = (att.getName() || '').toLowerCase();
  var ext  = name.indexOf('.') >= 0 ? name.split('.').pop() : '';
  var type = String(att.getContentType() || '').toLowerCase();
  return CONFIG.ALLOWED_EXT.indexOf(ext) >= 0 || type === 'application/pdf' || type.indexOf('image/') === 0;
}

function isForwardable_(att) {
  return att.getSize() > 0 && att.getSize() <= CONFIG.MAX_BYTES && isAllowedType_(att);
}

function names_(atts) {
  return atts.map(function (a) { return a.getName() || '(unnamed file)'; }).join(', ');
}

/** The fields WazzOCR files every report under. */
function meta_(msg, extra) {
  var body = {
    gmailMessageId: msg.getId(),
    from:           msg.getFrom(),
    subject:        msg.getSubject(),
    receivedAt:     msg.getDate().toISOString(),
  };
  for (var k in extra) body[k] = extra[k];
  return body;
}

/** POST JSON to WazzOCR with the API key. Returns { code, json, raw }. */
function post_(path, body) {
  var res = UrlFetchApp.fetch(CONFIG.WAZZOCR_API_BASE + path, {
    method: 'post',
    contentType: 'application/json',
    muteHttpExceptions: true,
    headers: { 'X-Api-Key': CONFIG.WAZZOCR_API_KEY },
    payload: JSON.stringify(body),
  });
  var raw = res.getContentText();
  var json = {};
  try { json = JSON.parse(raw) || {}; } catch (e) { json = {}; }
  return { code: res.getResponseCode(), json: json, raw: raw };
}

/**
 * Tell WazzOCR the script ran, which version it is, and how long the previous
 * run took. Returns its reply, or null.
 */
function heartbeat_() {
  try {
    var props = PropertiesService.getScriptProperties();
    var r = post_('/api/email/heartbeat', {
      version:   SCRIPT_VERSION,
      lastRunMs: Number(props.getProperty('lastRunMs') || 0),
      lastRunAt: props.getProperty('lastRunAt') || '',
    });
    if (r.code !== 200) Logger.log('Heartbeat → HTTP %s %s', r.code, r.raw.slice(0, 200));
    return r.code === 200 ? r.json : null;
  } catch (e) {
    Logger.log('Heartbeat failed: %s', e);
    return null;
  }
}

/**
 * Run ONCE if the mailbox already holds emails you do not want sent: records
 * every current attachment and email as done WITHOUT sending. New emails after
 * this are processed normally.
 */
function seedProcessed() {
  ensureLabels_();
  var props = PropertiesService.getScriptProperties();
  var processed = GmailApp.getUserLabelByName(CONFIG.PROCESSED_LABEL);
  var n = 0;
  GmailApp.search(searchQuery_(), 0, 200).forEach(function (thread) {
    thread.getMessages().forEach(function (msg) {
      props.setProperty('msg_' + msg.getId(), 'seed');
      msg.getAttachments({ includeInlineImages: false }).forEach(function (att) {
        props.setProperty('att_' + msg.getId() + '_' + att.getSize() + '_' + (att.getName() || ''), 'seed');
        n++;
      });
    });
    thread.addLabel(processed);
  });
  Logger.log('Marked %s existing attachment(s) as done. Send a NEW email to test.', n);
}

/** Forget what was sent, so the next run sends everything it sees again. */
function resetProcessed() {
  var props = PropertiesService.getScriptProperties();
  var n = 0;
  props.getKeys().forEach(function (k) {
    if (k.indexOf('att_') === 0 || k.indexOf('msg_') === 0) { props.deleteProperty(k); n++; }
  });
  Logger.log('Cleared %s record(s). WazzOCR still ignores files it already received.', n);
}

/** Create the labels and grant permissions. Run once. */
function setup() {
  ensureLabels_();
  DriveApp.getRootFolder();              // asks for Drive permission (bill archive)
  var hb = heartbeat_();
  Logger.log(hb ? 'Connected to WazzOCR. Now run installTrigger.'
                : 'Labels ready, but WazzOCR did not answer — check WAZZOCR_API_BASE and WAZZOCR_API_KEY.');
}

function ensureLabels_() {
  [CONFIG.SOURCE_LABEL, CONFIG.PROCESSED_LABEL, CONFIG.ERROR_LABEL].forEach(function (n) {
    if (!n) return;
    if (!GmailApp.getUserLabelByName(n)) GmailApp.createLabel(n);
  });
}

/** Check the mailbox every minute (the fastest Apps Script allows). Run once. */
function installTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'run') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('run').timeBased().everyMinutes(1).create();
  Logger.log('Trigger installed: run() every minute.');
}

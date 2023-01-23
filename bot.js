require('dotenv').config();
const wrapper = require('api-wrapper');
const mysql = require('mysql');

forum = wrapper.create({
  root: process.env.XF_URL + '/api/',
  parseJson: true,
  requestDefaults: {
    headers: { 'XF-Api-Key': process.env.XF_API_KEY },
  },
  get: {
    getThreads: 'threads/',
    getThread: 'threads/${id}/',
    getUser: 'users/${id}/',
    getForum: 'forums/${id}/threads/',
    getMessage: 'posts/${id}/',
  },
  post: {
    postMessage: 'posts/?thread_id|message',
    updateThread: 'threads/${id}/?prefix_id|title|discussion_open|sticky|custom_fields|add_tags|remove_tags',
    setThreadTag: 'threads/${id}/?custom_fields[${tag_name}]=${tag_value}',
  },
});

forumDb = undefined;
panelDb = undefined;
appealCache = [];

function dbConnect() {
  forumDb = mysql.createConnection({
    host: process.env.XF_DB_HOST,
    user: process.env.XF_DB_USER,
    password: process.env.XF_DB_PASS,
    database: process.env.XF_DB_NAME,
  });

  panelDb = mysql.createConnection({
    host: process.env.PANEL_DB_HOST,
    user: process.env.PANEL_DB_USER,
    password: process.env.PANEL_DB_PASS,
    database: process.env.PANEL_DB_NAME,
  });

  forumDb.connect(function (err) {
    if (err) {
      console.log('[MYSQL] ' + err);
      // setTimeout(dbConnect, 2000)
    } else {
      console.log('[MYSQL] Connected to forum database!');
    }
  });

  panelDb.connect(function (err) {
    if (err) {
      console.log('[MYSQL] ' + err);
      // setTimeout(dbConnect, 2000)
    } else {
      console.log('[MYSQL] Connected to panel database!');
    }
  });

  forumDb.on('error', function (err) {
    console.log('[MYSQL] Error!');
    console.log(err);

    if (err.code === 'PROTOCOL_CONNECTION_LOST') {
      console.log('[MYSQL] Reconnecting...');
      forumDb.end();
      console.log('[MYSQL] Closed old forum database connection.');
      setTimeout(dbConnect, 2000);
      console.log('[MYSQL] Reconnected to forum database.');
    } else {
      throw err;
    }
  });

  panelDb.on('error', function (err) {
    console.log('[MYSQL] Error!');
    console.log(err);

    if (err.code === 'PROTOCOL_CONNECTION_LOST') {
      console.log('[MYSQL] Reconnecting...');
      panelDb.end();
      console.log('[MYSQL] Closed old gextension database connection.');
      setTimeout(dbConnect, 2000);
      console.log('[MYSQL] Reconnected to gextension database.');
    } else {
      throw err;
    }
  });
}

function getBanAppeals() {
  // Get forum and put the json in a variable
  forum.getForum({ id: process.env.FORUM_NODE_ID }, '', function (_error, _message, body) {
    body.threads.forEach(function (val) {
      if ((val.prefix_id === 0) & val.title.toLowerCase().includes('appeal') && appealCache.includes(val.thread_id) === false) {
        appealCache.push(val.thread_id);
        checkBanAppeal(val.title, val.thread_id, val.custom_fields, val.user_id);
      }
    });
  });
}

function checkBanAppeal(title, threadid, _data, userid) {
  getUserSteamID(userid, function (steamid) {
    getBanOnUser(steamid, function (banInfo) {
      getForumUserBySteamID(banInfo.steamid64_admin, function (gotIt, adminUID) {
        console.log('Found new appeal from ' + steamid + ' (' + userid + ') for ban #' + banInfo.id);

        const unbanDate = new Date(banInfo.date_banned.getTime() + 60 * (1000 * banInfo.length));

        let p = '[B]Ban Information[/B]\n[LIST]';
        p = p + '\n[*][B]ID - [/B]#' + banInfo.id.toString();
        p = p + '\n[*][B]Reason - [/B]' + banInfo.reason;

        if (banInfo.length === 0) {
          p = p + '\n[*][B]Expiry - [/B] Permanent';
        } else {
          p = p + '\n[*][B]Expiry - [/B]' + unbanDate.toString();
        }

        p = p + '\n[*][B]User - [/B][URL=' + process.env.GEXTENSION_PANEL_URL + '/index.php?t=user&id=' + steamid + ']' + steamid + '[/URL]';

        if (gotIt === true) {
          p = p + '\n[*][B]Moderator - [/B][USER=' + adminUID + ']' + banInfo.steamid64_admin + '[/USER]';
        } else {
          if (banInfo.steamid64_admin !== '0') {
            p = p + '\n[*][B]Moderator - [/B]' + banInfo.steamid64_admin;
          }
        }

        p = p + '\n[/LIST]';
        p = escape(p);

        // If the thread title already has steamid in it, don't post it again
        // nor update the thread
        if (title.toLowerCase().includes(steamid.toLowerCase())) {
          console.log('[BANAPPEAL] Thread already contains steamid, skipping');
        } else {
          forum.updateThread(
            {
              id: threadid,
              prefix_id: process.env.FORUM_PREFIX,
              title: title + ' - ' + steamid,
            },
            '',
            function () {
              console.log('[BANAPPEAL] Updated thread title');
            }
          );
          forum.postMessage({ thread_id: threadid, message: p }, '', function () {
            console.log('[BANAPPEAL] Posted message to ban appeal');
          });
        }
      });
    });
  });
}

function getUserSteamID(userid, callback) {
  const sql = "SELECT provider_key FROM xf_user_connected_account WHERE provider = 'steam' AND user_id = ? LIMIT 1";
  const params = [userid];

  //validate the user input
  if (!userid) {
    return callback(new Error('User ID is missing'));
  }
  forumDb.query(sql, params, function (err, result) {
    if (err) return callback(err);

    if (result.length > 0) {
      callback(null, result[0].provider_key.toString());
    } else {
      callback(null, null);
    }
  });
}

function getForumUserBySteamID(steamid, callback) {
  if (!steamid) {
    return callback(new Error('Steam ID is missing'));
  }
  const sql = "SELECT user_id FROM xf_user_connected_account WHERE provider = 'steam' AND provider_key = ? LIMIT 1";
  const params = [steamid];

  forumDb.query(sql, params, function (err, result) {
    if (err) return callback(err);

    if (result.length > 0) {
      callback(null, true, result[0].user_id);
    } else {
      callback(null, false);
    }
  });
}

function getBanOnUser(steamid, callback) {
  if (!steamid) {
    return callback(new Error('Steam ID is missing'));
  }
  const sql =
    "SELECT id, date_banned, length, reason, steamid64_admin FROM gex_bans WHERE steamid64 = ? AND status = '0' AND (length = 0 OR DATE_ADD(date_banned, INTERVAL length minute) > CURRENT_TIMESTAMP())";
  const params = [steamid];

  panelDb.query(sql, params, function (err, result) {
    if (err) return callback(err);

    if (result.length > 0) {
      callback(null, result[0]);
    } else {
      callback(null, null);
    }
  });
}

const snooze = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const main = async () => {
  if (forumDb === undefined || panelDb === undefined || (forumDb.state === 'disconnected') & (panelDb.state === 'disconnected')) {
    console.log('Trying to connect to the databases...');
    dbConnect();
    await snooze(5000);
  } else {
    getBanAppeals();
  }

  await snooze(5000);
  await main();
};

main().then(() => console.log('Done!'));

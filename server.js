const { register, listen } = require("push-receiver-v2");
const sqlite3 = require("sqlite3").verbose();
const axios = require("axios");
const fs = require("fs");
require("dotenv").config();

const TOKEN_FILE = "/usr/src/cred/bl_auth.json";
// Path file untuk menyimpan kredensial
const CREDENTIALS_FILE = "/usr/src/cred/fcm_credentials.json";
// Path file database SQLite
const DATABASE_FILE = "/usr/src/cred/persistentIds.db";

// Membuka atau membuat database SQLite
const db = new sqlite3.Database(DATABASE_FILE);

// Membuat tabel untuk persistentId jika belum ada
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS persistentIds (
      id TEXT PRIMARY KEY
    )
  `);
});

// Fungsi untuk menyimpan kredensial ke file JSON
function storeCredentials(credentials) {
  fs.writeFileSync(CREDENTIALS_FILE, JSON.stringify(credentials, null, 2));
}

// Fungsi untuk memuat kredensial dari file JSON
function loadCredentials() {
  if (fs.existsSync(CREDENTIALS_FILE)) {
    return JSON.parse(fs.readFileSync(CREDENTIALS_FILE, "utf-8"));
  }
  return null;
}

// Fungsi untuk menyimpan persistentId ke database
function storePersistentId(persistentId) {
  db.run("INSERT OR IGNORE INTO persistentIds (id) VALUES (?)", [persistentId]);
}

// Fungsi untuk memuat semua persistentId dari database
function loadPersistentIds() {
  return new Promise((resolve, reject) => {
    db.all("SELECT id FROM persistentIds", [], (err, rows) => {
      if (err) {
        reject(err);
      } else {
        resolve(rows.map((row) => row.id));
      }
    });
  });
}

// Fungsi untuk mendengarkan notifikasi
async function main(accessToken = null) {
  let credentials = loadCredentials();

  if (!credentials) {
    console.log("Kredensial tidak ditemukan, melakukan registrasi baru...");
    const config = {
      firebase: {
        apiKey: "AIzaSyDgWIU-L1F0jB4_pLswBJqDPKyRRO0vES0",
        appID: "1:1024277213961:android:ee232975f3b7a641",
        projectID: "mitra-bukalapak-7007e",
      },
      vapidKey: "", // Opsional
    };

    // Registrasi ke FCM
    credentials = await register(config);
    storeCredentials(credentials);
    console.log("Registrasi selesai. Kredensial disimpan.");
  } else {
    console.log("Kredensial ditemukan.");
  }
  // console.log("DEVICE TOKEN: " + credentials.fcm.token);
  if (accessToken) {
    await setFcm(accessToken, credentials.fcm.token);
  }

  const persistentIds = await loadPersistentIds();

  // Mulai mendengarkan notifikasi
  console.log("Memulai mendengarkan notifikasi...");
  await listen(
    {
      ...credentials,
      persistentIds,
    },
    ({ notification, persistentId }) => {
      console.log("Notifikasi diterima:", notification);
      var n = parseNotification(notification);
      if (n) {
        const payload = {
          amount: Number(n["nominalTrx"]),
          wallet: "QRIS",
          description: `${n["id"]}|${n["paymentId"]}`,
          raw: n["raw"],
        };
        sendBankingTransaction(payload).then((r) => {
          // console.log(r);
        });
      }
      // Simpan persistentId baru ke database
      storePersistentId(persistentId);
    },
  );
}

async function getAccessToken(initialRefreshToken = null) {
  try {
    let refreshToken;

    // Periksa apakah file token.json ada
    if (fs.existsSync(TOKEN_FILE)) {
      const tokenData = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
      refreshToken = tokenData.refresh_token;
    } else {
      // Gunakan initialRefreshToken jika file tidak ada
      if (!initialRefreshToken) {
        throw new Error(
          "File token.json tidak ditemukan dan initial refresh token tidak diberikan.",
        );
      }
      refreshToken = initialRefreshToken;
    }

    // Kirim permintaan ke endpoint OAuth Bukalapak
    const response = await axios.post(
      "https://accounts.bukalapak.com/oauth/token",
      new URLSearchParams({
        client_id: "f75b74c4bc516a7cb1a9296c",
        client_secret:
          "21917306538e84213f03be749673f1f5c538216513b31ff80e32de68d1aaa949",
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }).toString(),
      {
        headers: {
          "Accept-Encoding": "gzip",
          "Content-Type": "application/x-www-form-urlencoded",
        },
      },
    );

    // Parse hasil respon
    const tokenData = response.data;

    // Simpan hasil respon ke file JSON lokal
    fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokenData, null, 2), "utf8");

    // Kembalikan access_token
    return tokenData.access_token;
  } catch (error) {
    console.error("Gagal mendapatkan access token:", error.message);
    throw error;
  }
}
async function setFcm(accessToken, fcmToken) {
  try {
    const payload = {
      fcm_token: fcmToken,
      notification_permission: "authorized",
      platform: "mitra_android",
    };

    // Kirim permintaan ke API Bukalapak
    const response = await axios.put(
      "https://api.bukalapak.com/_exclusive/notifications/devices",
      payload,
      {
        headers: {
          "User-Agent":
            "Dalvik/2.1.0 (Linux; U; Android 15; MX2101K6G Build/AP3A.241105.008) 2042001 BLMitraAndroid",
          Accept: "application/json",
          "Accept-Encoding": "gzip",
          "Bukalapak-Mitra-Version": "2042001",
          "X-User-Id": "9632181",
          "X-Device-Ad-Id": "dab94ffa-ef67-4558-a96b-47749df49945",
          "Bukalapak-Identity": "f0256b6677cb7e33",
          "Bukalapak-App-Version": "4037005",
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json; charset=UTF-8",
        },
      },
    );

    // Kembalikan respon
    return response.data;
  } catch (error) {
    console.error("Gagal mengirim FCM token:", error.message);
    if (error.response) {
      console.error("Respon dari server:", error.response.data);
    }
    throw error;
  }
}
async function getTransactions(accessToken) {
  try {
    // Kirim permintaan ke API Bukalapak
    const response = await axios.get(
      "https://api.bukalapak.com/mitra-payment/transactions?list_types[]=wallet&v=2",
      {
        headers: {
          "Bukalapak-Mitra-Version": "2042001",
          Authorization: `Bearer ${accessToken}`,
        },
      },
    );

    // Parse hasil respon
    const data = response.data?.data || [];

    // Filter data untuk hanya trx_type=qris
    const filteredData = data.filter(
      (transaction) => transaction.trx_type === "qris",
    );

    // Kembalikan data yang sudah difilter
    return filteredData;
  } catch (error) {
    console.error("Gagal mendapatkan data transaksi:", error.message);
    throw error;
  }
}
function parseNotification(notification) {
  if (notification.data.body.search("INV-GR-") < 10) {
    return null;
  }
  try {
    // Ambil id dan payment_id dari deeplinkSheetUrl
    const deeplinkUrl = notification.data.deeplinkSheetUrl;
    const urlParams = new URL(deeplinkUrl);
    const id = urlParams.searchParams.get("id");
    const paymentId = urlParams.searchParams.get("payment_id");

    // Ambil nominal transaksi dari body
    const bodyText = notification.data.body
      .replaceAll(".", "")
      .replaceAll(",00", "");
    const nominalMatch = bodyText.match(/Rp(\d+)/);
    const nominalTrx = nominalMatch ? parseInt(nominalMatch[1], 10) : null;

    var data = {
      id: id,
      paymentId: paymentId,
      nominalTrx: nominalTrx,
      raw: JSON.stringify(notification),
    };

    // Kembalikan data yang sudah diparsing
    return data;
  } catch (error) {
    console.error("Gagal menguraikan notifikasi:", error.message);
    return null;
  }
}
async function sendBankingTransaction(payload) {
  const url = `${process.env.SUPABASE_URL}/rest/v1/banking_transactions`;

  const headers = {
    Apikey: process.env.SUPABASE_ANON,
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE}`,
    "Content-Type": "application/json",
  };

  const response = await axios(url, {
    method: "POST",
    headers,
    data: JSON.stringify(payload),
    validateStatus: (s) => true,
  });

  const responseBody = await response.data;
  return responseBody;
}

async function refreshFcmTokenInterval() {
  var fcmtoken = loadCredentials().fcm.token;
  console.log("Refreshing FCM token...");
  try {
    const accessToken = await getAccessToken();
    await setFcm(accessToken, fcmtoken);
  } catch (error) {
    console.error("Gagal mendapatkan token FCM:", error.message);
  }
}

// Contoh penggunaan
getAccessToken(process.env.BL_REFRESH_TOKEN)
  .then(async (accessToken) => {
    // var trx = await getTransactions(accessToken);
    // console.log("Access Token:", accessToken);
    // Menjalankan fungsi utama
    setInterval(refreshFcmTokenInterval, 60 * 1000 * 15);
    main(accessToken).catch((err) => {
      console.error("Terjadi kesalahan:", err);
    });
  })
  .catch((error) => {
    console.error("Error:", error.message);
  });

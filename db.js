require('dotenv').config(); // Tải các biến từ file .env
const fs = require('fs');
const mysql = require('mysql2/promise');
const { Client } = require('ssh2');

const sshConfig = {
  host: process.env.SSH_HOST,
  port: 22,
  username: process.env.SSH_USER,
  // Dùng biến SSH_PRIVATE_KEY thay vì đọc file trực tiếp
  privateKey: process.env.SSH_PRIVATE_KEY 
};

const dbConfig = {
  host: '127.0.0.1',
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
};

// ... (phần code còn lại của db.js giữ nguyên)
// ... (phần tạo tunnel và hàm query)
const sshClient = new Client();
let dbConnection;

const connectToDatabase = () => {
    return new Promise((resolve, reject) => {
        sshClient.on('ready', () => {
            console.log('✅ Kết nối SSH thành công!');
            sshClient.forwardOut('127.0.0.1', 0, dbConfig.host, 3306, async (err, stream) => {
                if (err) return reject(err);
                console.log('✅ Đường hầm SSH đã được tạo!');
                const updatedDbConfig = { ...dbConfig, stream };
                dbConnection = await mysql.createConnection(updatedDbConfig);
                console.log('✅ Kết nối Database qua đường hầm thành công!');
                resolve(dbConnection);
            });
        }).connect(sshConfig);
        sshClient.on('error', (err) => {
            console.error('Lỗi kết nối SSH:', err);
            reject(err);
        });
    });
};

async function query(sql) {
    if (!dbConnection) {
        await connectToDatabase();
    }
    try {
        const [results] = await dbConnection.execute(sql);
        return results;
    } catch (error) {
        console.error("Lỗi khi thực thi câu lệnh SQL:", error);
        dbConnection = null; 
        throw error;
    }
}

module.exports = { query };
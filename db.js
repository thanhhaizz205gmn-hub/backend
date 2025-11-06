// =================================================================
// FILE: backend/db.js (Bản dành cho Deploy)
// =================================================================
require('dotenv').config(); // Tải các biến từ file .env (dùng khi test local)
const fs = require('fs');
const mysql = require('mysql2/promise');
const { Client } = require('ssh2');

const sshConfig = {
  host: process.env.SSH_HOST,
  port: process.env.SSH_PORT || 2222, // Dùng cổng 2222 làm mặc định
  username: process.env.SSH_USER,
  // Dùng biến SSH_PRIVATE_KEY (an toàn hơn)
  // Render sẽ đọc biến này, còn local sẽ đọc từ file .env
  privateKey: process.env.SSH_PRIVATE_KEY.replace(/\\n/g, '\n')
};

const dbConfig = {
  host: '127.0.0.1',
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
};

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
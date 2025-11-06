// =================================================================
// FILE: backend/db.js (Dùng cho Localhost)
// =================================================================
const fs = require('fs');
const mysql = require('mysql2/promise');
const { Client } = require('ssh2');

const sshConfig = {
  host: '210.245.59.166',
  port: 2222,
  username: 'gam',
  // ⚠️ THAY BẰNG MẬT KHẨU SSH CỦA BẠN
  // Đây là mật khẩu bạn dùng để đăng nhập vào server Ubuntu
  password: 'Binh-Gami_An!2%0&25' 
};

const dbConfig = {
  host: '127.0.0.1',
  user: 'root',
  password: '011104',
  database: 'moodle',
};

const sshClient = new Client();
let dbConnection;

const connectToDatabase = () => {
    return new Promise((resolve, reject) => {
        sshClient.on('ready', () => {
            console.log('✅ Kết nối SSH thành công! (Local)');
            sshClient.forwardOut('127.0.0.1', 0, dbConfig.host, 3306, async (err, stream) => {
                if (err) return reject(err);
                console.log('✅ Đường hầm SSH đã được tạo! (Local)');
                const updatedDbConfig = { ...dbConfig, stream };
                dbConnection = await mysql.createConnection(updatedDbConfig);
                console.log('✅ Kết nối Database qua đường hầm thành công! (Local)');
                resolve(dbConnection);
            });
        }).connect(sshConfig);
        sshClient.on('error', (err) => {
            console.error('Lỗi kết nối SSH (Local):', err);
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
        console.error("Lỗi khi thực thi câu lệnh SQL (Local):", error);
        dbConnection = null; 
        throw error;
    }
}

module.exports = { query };
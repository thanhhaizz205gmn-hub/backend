const mysql = require('mysql2/promise');
const { Client } = require('ssh2');
const fs = require('fs');

// --- ⚠️ CẤU HÌNH CỦA BẠN ---
const sshConfig = {
  host: '3.83.207.81',
  port: 22,
  username: 'ubuntu',
  privateKey: fs.readFileSync('C:\\Users\\LG Gram\\OneDrive\\Máy tính\\suu.pem') // ⚠️ SỬA LẠI ĐÚNG ĐƯỜNG DẪN FILE .pem
};

const dbConfig = {
  host: '127.0.0.1', // Luôn là 127.0.0.1 khi dùng tunnel
  user: 'moodleuser',
  password: '011104',
  database: 'moodle',
};
// -------------------------

const sshClient = new Client();
let dbConnection;

const connectToDatabase = () => {
  return new Promise((resolve, reject) => {
    sshClient.on('ready', () => {
      console.log('✅ Kết nối SSH thành công!');
      sshClient.forwardOut(
        '127.0.0.1',
        0,
        dbConfig.host,
        3306, // Cổng MySQL mặc định
        async (err, stream) => {
          if (err) return reject(err);
          console.log('✅ Đường hầm SSH đã được tạo!');

          const updatedDbConfig = { ...dbConfig, stream };
          dbConnection = await mysql.createConnection(updatedDbConfig);

          console.log('✅ Kết nối Database qua đường hầm thành công!');
          resolve(dbConnection);
        }
      );
    }).connect(sshConfig);

    sshClient.on('error', (err) => {
        console.error('Lỗi kết nối SSH:', err);
        reject(err);
    });
  });
};

// Hàm để chạy câu lệnh SQL
async function query(sql) {
    if (!dbConnection) {
        await connectToDatabase();
    }
    try {
        const [results] = await dbConnection.execute(sql);
        return results;
    } catch (error) {
        console.error("Lỗi khi thực thi câu lệnh SQL:", error);
        // Cố gắng kết nối lại nếu có lỗi
        dbConnection = null; 
        throw error;
    }
}

module.exports = { query };
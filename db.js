const mysql = require('mysql2/promise');
const { Client } = require('ssh2');

// Sửa lại đoạn này trong file db.js
const sshConfig = {
  host: '3.83.207.81',
  port: 22,
  username: 'ubuntu',
  // Đọc file từ đường dẫn bí mật của Render
  privateKey: fs.readFileSync('/etc/secrets/suu.pem') 
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
// =================================================================
// PHẦN 1: IMPORT VÀ THIẾT LẬP
// =================================================================
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const cors = require('cors');
const db = require('./db.js');

const app = express();
app.use(cors());
app.use(express.urlencoded({ extended: true }));
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });
const PORT = 3001;

// =================================================================
// PHẦN 2: CÁC BIẾN VÀ HÀM HỖ TRỢ
// =================================================================
const matchmakingQueue = {};
const gameRooms = {};
const playersInfo = {};
const tempTokens = {};

// Hàm xử lý cho Question Bank tiêu chuẩn (dùng cột 'fraction')
function processRawQuestions(rows) {
    const questionsMap = new Map();
    for (const row of rows) {
        const questionText = row.question_text.replace(/<[^>]*>/g, '').trim();
        const answerText = row.answer_text.replace(/<[^>]*>/g, '').trim();
        if (!questionsMap.has(row.question_id)) {
            questionsMap.set(row.question_id, {
                question: questionText,
                answers: [],
                correctAnswer: ''
            });
        }
        const question = questionsMap.get(row.question_id);
        question.answers.push(answerText);
        // Dùng 'fraction' cho câu hỏi từ Question Bank
        if (parseFloat(row.fraction) > 0) { 
            question.correctAnswer = answerText;
        }
    }
    questionsMap.forEach(q => { q.answers.sort(() => Math.random() - 0.5); });
    return Array.from(questionsMap.values());
}

// (Chúng ta sẽ thêm hàm saveGameResult cho Supabase sau khi deploy)

// =================================================================
// PHẦN 3: CÁC API ENDPOINT
// =================================================================
app.get('/api/courses', async (req, res) => {
    try {
        const courses = await db.query('SELECT id, fullname AS name FROM mdl_course WHERE visible = 1');
        res.json(courses);
    } catch (error) {
        res.status(500).json({ message: "Không thể lấy dữ liệu khóa học từ Moodle DB." });
    }
});
app.get('/api/ranking', (req, res) => { res.json([]); }); // Tạm thời trả về rỗng

// =================================================================
// PHẦN 4: LOGIC GAME REAL-TIME
// =================================================================
io.on('connection', (socket) => {
    console.log('Một người chơi đã kết nối:', socket.id);
    io.emit('online_players_update', io.engine.clientsCount);
    socket.on('disconnect', () => { io.emit('online_players_update', io.engine.clientsCount); });

    socket.on('player_identify', (data) => {
        // (Logic LTI sẽ thêm vào sau khi deploy)
    });

    socket.on('join_queue', async (data) => {
        const { courseId } = data;
        if (!matchmakingQueue[courseId]) { matchmakingQueue[courseId] = []; }
        matchmakingQueue[courseId].push(socket.id);

        if (matchmakingQueue[courseId].length >= 2) {
            const player1Id = matchmakingQueue[courseId].shift();
            const player2Id = matchmakingQueue[courseId].shift();

            // === LOGIC MỚI: KIỂM TRA NGƯỜI CHƠI CÒN KẾT NỐI KHÔNG ===
            const player1Socket = io.sockets.sockets.get(player1Id);
            const player2Socket = io.sockets.sockets.get(player2Id);

            if (!player1Socket) {
                console.log(`Người chơi ${player1Id} đã ngắt kết nối. Đưa ${player2Id} trở lại hàng chờ.`);
                if (player2Socket) matchmakingQueue[courseId].push(player2Id); // Đưa người chơi 2 về lại hàng chờ
                return;
            }
            if (!player2Socket) {
                console.log(`Người chơi ${player2Id} đã ngắt kết nối. Đưa ${player1Id} trở lại hàng chờ.`);
                matchmakingQueue[courseId].push(player1Id); // Đưa người chơi 1 về lại hàng chờ
                return;
            }
            // =========================================================

            try {
                // 1. Tìm một danh mục câu hỏi ngẫu nhiên thuộc khóa học
                console.log(`Tìm trận cho khóa học ID: ${courseId}. Bắt đầu lấy câu hỏi từ Question Bank...`);
                const categorySql = `
                    SELECT DISTINCT cat.id 
                    FROM mdl_question_categories cat 
                    JOIN mdl_context ctx ON cat.contextid = ctx.id 
                    JOIN mdl_question_bank_entries qbe ON qbe.questioncategoryid = cat.id
                    WHERE ctx.path LIKE CONCAT((SELECT path FROM mdl_context WHERE contextlevel=50 AND instanceid=${courseId}), '/%')
                    ORDER BY RAND() 
                    LIMIT 1
                `;
                const categories = await db.query(categorySql);
                if (categories.length === 0) { throw new Error(`Không tìm thấy danh mục câu hỏi nào (có chứa câu hỏi) cho khóa học ${courseId}.`); }
                const categoryId = categories[0].id;
                console.log(`Đã tìm thấy danh mục câu hỏi (có câu hỏi) ID: ${categoryId}`);

                // 2. Lấy câu hỏi từ danh mục đó
                const questionSql = `
                    SELECT 
                        q.id AS question_id, 
                        q.questiontext AS question_text, 
                        qa.answer AS answer_text, 
                        qa.fraction 
                    FROM 
                        mdl_question_bank_entries qbe
                    JOIN 
                        mdl_question q ON qbe.id = q.id 
                    JOIN 
                        mdl_question_answers qa ON q.id = qa.question 
                    WHERE 
                        qbe.questioncategoryid = ${categoryId}
                    ORDER BY 
                        q.id
                `;
                const rawQuestions = await db.query(questionSql);
                
                const questions = processRawQuestions(rawQuestions);
                if (questions.length === 0) { throw new Error(`Không tìm thấy câu hỏi nào trong danh mục ${categoryId} (lỗi logic)`); }
                console.log(`✅ Lấy thành công ${questions.length} câu hỏi thật từ Question Bank.`);
                
                // Các bước còn lại giữ nguyên
                const roomId = `room-${player1Id}-${player2Id}`;
                player1Socket.join(roomId); // Bây giờ lệnh join() đã an toàn
                player2Socket.join(roomId);
                
                const player1Name = playersInfo[player1Id]?.name || `Player_${player1Id.substring(0,5)}`;
                const player2Name = playersInfo[player2Id]?.name || `Player_${player2Id.substring(0,5)}`;
                
                gameRooms[roomId] = {
                    players: [ { id: player1Id, name: player1Name, score: 0, hp: 100 }, { id: player2Id, name: player2Name, score: 0, hp: 100 } ],
                    questions: questions,
                    currentQuestionIndex: 0,
                    questionStartTime: Date.now(),
                    isQuestionAnswered: false,
                    timer: null
                };
                io.to(roomId).emit('game_start', { roomId: roomId, players: gameRooms[roomId].players, question: questions[0] });
                startQuestionTimer(roomId); // Bắt đầu timer cho câu hỏi đầu

            } catch (error) {
                console.error("Đã xảy ra lỗi khi bắt đầu trận đấu:", error.message);
            }
        }
    });

    socket.on('submit_answer', (data) => {
        const { roomId, answer } = data;
        const room = gameRooms[roomId];
        if (!room || room.isQuestionAnswered) { return; }

        clearTimeout(room.timer); // Dừng timer ngay khi có người trả lời
        room.isQuestionAnswered = true;
        
        const timeTaken = (Date.now() - room.questionStartTime) / 1000;
        const question = room.questions[room.currentQuestionIndex];
        const isCorrect = (answer === question.correctAnswer);
        const playerIndex = room.players.findIndex(p => p.id === socket.id);
        
        if (playerIndex !== -1) {
            if (isCorrect) {
                const timeBonus = Math.floor(Math.max(0, QUESTION_TIME_LIMIT - timeTaken) * 10);
                room.players[playerIndex].score += BASE_SCORE + timeBonus;
            } else {
                room.players[playerIndex].hp -= 20; 
            }
        }
        
        io.to(roomId).emit('round_result', { isCorrect: isCorrect, answeredPlayerId: socket.id, players: room.players });
        
        setTimeout(() => {
            const player1 = room.players[0];
            const player2 = room.players[1];
            
            if (player1.hp <= 0 || player2.hp <= 0) {
                console.log(`[Game End] Một người chơi đã hết máu.`);
                const finalState = room.players;
                io.to(roomId).emit('game_over', { 
                    message: "Trận đấu kết thúc!",
                    finalState: finalState,
                    roomId: roomId 
                });
                // saveGameResult(finalState); 
                return; 
            }

            room.currentQuestionIndex++;
            if (room.currentQuestionIndex < room.questions.length) {
                const nextQuestion = room.questions[room.currentQuestionIndex];
                room.questionStartTime = Date.now();
                room.isQuestionAnswered = false; 
                io.to(roomId).emit('new_question', { question: nextQuestion });
                startQuestionTimer(roomId); // Bắt đầu timer cho câu hỏi mới
            } else {
                console.log(`[Game End] Hết câu hỏi.`);
                const finalState = room.players;
                io.to(roomId).emit('game_over', { 
                    message: "Trận đấu kết thúc!",
                    finalState: finalState,
                    roomId: roomId 
                });
                // saveGameResult(finalState); 
            }
        }, 2000);
    });
});

// =================================================================
// PHẦN 5: KHỞI ĐỘNG SERVER
// =================================================================
const QUESTION_TIME_LIMIT = 30;
const BASE_SCORE = 20;

function startQuestionTimer(roomId) {
    const room = gameRooms[roomId];
    if (!room) return;
    if (room.timer) { clearTimeout(room.timer); }
    room.timer = setTimeout(() => {
        if (room && !room.isQuestionAnswered) {
            console.log(`[Game End] Hết giờ cho phòng ${roomId}`);
            room.isQuestionAnswered = true; 
            const finalState = room.players;
            io.to(roomId).emit('game_over', { 
                message: "Hết giờ! Trận đấu kết thúc!",
                finalState: finalState,
                roomId: roomId 
            });
            // saveGameResult(finalState); 
        }
    }, (QUESTION_TIME_LIMIT * 1000) + 1000); 
}

server.listen(PORT, () => {
    console.log(`🚀 Server backend đang chạy tại http://localhost:${PORT}`);
});
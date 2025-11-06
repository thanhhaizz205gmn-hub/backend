// =================================================================
// FILE: backend/index.js (Bản dành cho Deploy)
// =================================================================
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const cors = require('cors');
const db = require('./db.js');
const lti = require('ims-lti');
const { createClient } = require('@supabase/supabase-js');

// Tải biến môi trường (quan trọng cho Render)
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const FRONTEND_URL = process.env.FRONTEND_URL;
const LTI_KEY = process.env.LTI_KEY;
const LTI_SECRET = process.env.LTI_SECRET;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const app = express();
app.use(cors());
app.use(express.urlencoded({ extended: true }));
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });
const PORT = process.env.PORT || 3001; // Render cần dòng này

// --- Các biến và hàm hỗ trợ ---
const matchmakingQueue = {};
const gameRooms = {};
const playersInfo = {};
const tempTokens = {};

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
        if (parseFloat(row.fraction) > 0) { 
            question.correctAnswer = answerText;
        }
    }
    questionsMap.forEach(q => { q.answers.sort(() => Math.random() - 0.5); });
    return Array.from(questionsMap.values());
}

async function saveGameResult(finalPlayers) {
    try {
        console.log("Đang lưu kết quả trận đấu vào Supabase...");
        for (const player of finalPlayers) {
            const moodleInfo = playersInfo[player.id];
            if (!moodleInfo || !moodleInfo.id) continue;

            const { data: existingPlayer } = await supabase
                .from('players')
                .select('total_score, matches_played')
                .eq('moodle_id', moodleInfo.id)
                .single();

            if (existingPlayer) {
                await supabase.from('players').update({ 
                    total_score: existingPlayer.total_score + player.score,
                    matches_played: existingPlayer.matches_played + 1,
                    name: moodleInfo.name
                }).eq('moodle_id', moodleInfo.id);
            } else {
                await supabase.from('players').insert({ 
                    moodle_id: moodleInfo.id, 
                    name: moodleInfo.name, 
                    total_score: player.score,
                    matches_played: 1 
                });
            }
        }
        console.log("✅ Đã lưu kết quả thành công vào Supabase.");
    } catch (error) {
        if (error.code !== 'PGRST116') { 
            console.error("Lỗi khi lưu kết quả vào Supabase:", error.message);
        }
    }
}

// --- API Endpoints ---
app.post('/lti/launch', (req, res) => {
    const provider = new lti.Provider(LTI_KEY, LTI_SECRET);
    provider.valid_request(req, (err, isValid) => {
        if (err || !isValid) {
            return res.status(401).send("Yêu cầu LTI không hợp lệ.");
        }
        const userId = provider.body.user_id;
        const userName = provider.body.lis_person_full_name;
        const tempToken = require('crypto').randomBytes(16).toString('hex');
        tempTokens[tempToken] = { id: userId, name: userName };
        setTimeout(() => delete tempTokens[tempToken], 60000);
        res.redirect(`${FRONTEND_URL}?launch_token=${tempToken}`);
    });
});

app.get('/api/courses', async (req, res) => {
    try {
        const courses = await db.query('SELECT id, fullname AS name FROM mdl_course WHERE visible = 1');
        res.json(courses);
    } catch (error) {
        res.status(500).json({ message: "Không thể lấy dữ liệu khóa học từ Moodle DB." });
    }
});

app.get('/api/ranking', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('players')
            .select('name, total_score')
            .order('total_score', { ascending: false })
            .limit(10);
        if (error) throw error;
        res.json(data);
    } catch (error) {
        res.status(500).json({ message: "Không thể lấy bảng xếp hạng." });
    }
});

// --- Logic Game Real-time ---
io.on('connection', (socket) => {
    console.log('Một người chơi đã kết nối:', socket.id);
    io.emit('online_players_update', io.engine.clientsCount);
    socket.on('disconnect', () => { io.emit('online_players_update', io.engine.clientsCount); });

    socket.on('player_identify', (data) => {
        const userInfo = tempTokens[data.token];
        if (userInfo) {
            playersInfo[socket.id] = userInfo;
            delete tempTokens[data.token];
            console.log(`✅ Người chơi ${socket.id} đã được xác thực là ${userInfo.name} (Moodle ID: ${userInfo.id})`);
        }
    });

    socket.on('join_queue', async (data) => {
        const { courseId } = data;
        if (!matchmakingQueue[courseId]) { matchmakingQueue[courseId] = []; }
        matchmakingQueue[courseId].push(socket.id);

        if (matchmakingQueue[courseId].length >= 2) {
            try {
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

                const questionSql = `
                    SELECT 
                        q.id AS question_id, q.questiontext AS question_text, 
                        qa.answer AS answer_text, qa.fraction 
                    FROM mdl_question_bank_entries qbe
                    JOIN mdl_question q ON qbe.id = q.id 
                    JOIN mdl_question_answers qa ON q.id = qa.question 
                    WHERE qbe.questioncategoryid = ${categoryId}
                    ORDER BY q.id
                `;
                const rawQuestions = await db.query(questionSql);
                const questions = processRawQuestions(rawQuestions);
                if (questions.length === 0) { throw new Error(`Không tìm thấy câu hỏi nào trong danh mục ${categoryId} (lỗi logic)`); }
                console.log(`✅ Lấy thành công ${questions.length} câu hỏi thật từ Question Bank.`);
                
                const player1Id = matchmakingQueue[courseId].shift();
                const player2Id = matchmakingQueue[courseId].shift();
                const roomId = `room-${player1Id}-${player2Id}`;
                const player1Socket = io.sockets.sockets.get(player1Id);
                const player2Socket = io.sockets.sockets.get(player2Id);
                player1Socket.join(roomId);
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
                startQuestionTimer(roomId);

            } catch (error) {
                console.error("Đã xảy ra lỗi khi bắt đầu trận đấu:", error.message);
            }
        }
    });

    const QUESTION_TIME_LIMIT = 30;
    const BASE_SCORE = 20;
    socket.on('submit_answer', (data) => {
        const { roomId, answer } = data;
        const room = gameRooms[roomId];
        if (!room || room.isQuestionAnswered) { return; }
        clearTimeout(room.timer);
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
                io.to(roomId).emit('game_over', { message: "Trận đấu kết thúc!", finalState: finalState, roomId: roomId });
                saveGameResult(finalState); 
                return; 
            }
            room.currentQuestionIndex++;
            if (room.currentQuestionIndex < room.questions.length) {
                const nextQuestion = room.questions[room.currentQuestionIndex];
                room.questionStartTime = Date.now();
                room.isQuestionAnswered = false; 
                io.to(roomId).emit('new_question', { question: nextQuestion });
                startQuestionTimer(roomId);
            } else {
                console.log(`[Game End] Hết câu hỏi.`);
                const finalState = room.players;
                io.to(roomId).emit('game_over', { message: "Trận đấu kết thúc!", finalState: finalState, roomId: roomId });
                saveGameResult(finalState); 
            }
        }, 2000);
    });
});

// --- Hàm Timer ---
function startQuestionTimer(roomId) {
    const room = gameRooms[roomId];
    if (!room) return;
    if (room.timer) { clearTimeout(room.timer); }
    room.timer = setTimeout(() => {
        if (room && !room.isQuestionAnswered) {
            console.log(`[Game End] Hết giờ cho phòng ${roomId}`);
            room.isQuestionAnswered = true; 
            const finalState = room.players;
            io.to(roomId).emit('game_over', { message: "Hết giờ! Trận đấu kết thúc!", finalState: finalState, roomId: roomId });
            saveGameResult(finalState); 
        }
    }, (QUESTION_TIME_LIMIT * 1000) + 1000); 
}

// --- Khởi động Server ---
server.listen(PORT, () => {
    console.log(`🚀 Server backend đang chạy tại http://localhost:${PORT}`);
});
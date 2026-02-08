require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const bcrypt = require('bcryptjs');

const app = express();
const PORT = process.env.PORT || 3000;
const TEACHER_SECRET_CODE = "TEACHER2024";

app.use(cors());
app.use(express.json());

const uploadDir = './uploads';
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
app.use('/uploads', express.static(uploadDir));

const MONGO_URI = process.env.MONGO_URI;

if (!MONGO_URI) {
    console.error("❌ MONGO_URI is missing!");
} else {
    mongoose.connect(MONGO_URI)
        .then(() => console.log("✅ MongoDB Connected"))
        .catch(err => console.log("❌ MongoDB Error:", err));
}

// --- UPDATED SCHEMAS ---

const UserSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    name: String,
    role: { type: String, enum: ['teacher', 'student'], required: true },
    // 1. Added personalNotes array to store private captures
    personalNotes: [{
        filename: String,
        path: String,
        uploadDate: { type: Date, default: Date.now }
    }]
});
const User = mongoose.model('User', UserSchema);

const ClassSchema = new mongoose.Schema({
    name: String,
    teacherId: String,
    code: { type: String, unique: true },
    students: [String],
    files: [{
        filename: String,
        path: String,
        uploadDate: { type: Date, default: Date.now }
    }]
});
const Classroom = mongoose.model('Classroom', ClassSchema);

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname.replace(/\s+/g, '_'))
});
const upload = multer({ storage: storage });

// --- ROUTES ---

// Existing Register/Login logic remains the same...
app.post('/register', async (req, res) => {
    const { username, password, name, role, secretCode } = req.body;
    try {
        const existing = await User.findOne({ username });
        if (existing) return res.status(400).json({ error: "Username/Email already exists" });
        if (role === 'teacher' && secretCode !== TEACHER_SECRET_CODE) {
            return res.status(403).json({ error: "Invalid Teacher Secret Code" });
        }
        const hashedPassword = await bcrypt.hash(password, 10);
        const newUser = new User({ username, password: hashedPassword, name, role, personalNotes: [] });
        await newUser.save();
        res.json({ success: true, userId: newUser._id, name: newUser.name, role: newUser.role });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const user = await User.findOne({ username });
        if (!user) return res.status(400).json({ error: "User not found" });
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) return res.status(400).json({ error: "Invalid credentials" });
        res.json({ success: true, userId: user._id, name: user.name, role: user.role });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- NEW PERSONAL & SHARING ROUTES ---

// 2. Route to save to teacher's private records
app.post('/upload-personal/:userId', upload.single('pdf'), async (req, res) => {
    try {
        const user = await User.findById(req.params.userId);
        if (!user) return res.status(404).json({ error: "User not found" });
        user.personalNotes.push({ filename: req.file.originalname, path: req.file.path });
        await user.save();
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 3. Route to fetch personal notes for the Dashboard
app.get('/personal-notes/:userId', async (req, res) => {
    try {
        const user = await User.findById(req.params.userId);
        if (!user) return res.status(404).json({ error: "User not found" });
        res.json({ notes: user.personalNotes || [] });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 4. Route to "Publish" a personal note to a class
app.post('/share-to-class', async (req, res) => {
    try {
        const { classId, fileData } = req.body;
        const classroom = await Classroom.findById(classId);
        if (!classroom) return res.status(404).json({ error: "Class not found" });
        
        classroom.files.push({
            filename: fileData.filename,
            path: fileData.path,
            uploadDate: new Date()
        });
        await classroom.save();
        res.json({ success: true, message: "Shared with enrolled students!" });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Standard Class routes remain the same...
app.post('/create-class', async (req, res) => {
    const { name, teacherId } = req.body;
    const code = Math.random().toString(36).substring(2, 8).toUpperCase();
    try {
        const newClass = new Classroom({ name, teacherId, code, students: [], files: [] });
        await newClass.save();
        res.json(newClass);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/join-class', async (req, res) => {
    const { studentId, classCode } = req.body;
    try {
        const classroom = await Classroom.findOne({ code: classCode });
        if (!classroom) return res.status(404).json({ error: "Class not found" });
        if (!classroom.students.includes(studentId)) {
            classroom.students.push(studentId);
            await classroom.save();
        }
        res.json(classroom);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/classes/:userId/:role', async (req, res) => {
    const { userId, role } = req.params;
    try {
        let classes;
        if (role === 'teacher') classes = await Classroom.find({ teacherId: userId });
        else classes = await Classroom.find({ students: userId });
        res.json(classes);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/upload/:classId', upload.single('pdf'), async (req, res) => {
    try {
        const classroom = await Classroom.findById(req.params.classId);
        if (!classroom) return res.status(404).json({ error: "Class not found" });
        classroom.files.push({ filename: req.file.originalname, path: req.file.path });
        await classroom.save();
        res.json({ message: "Success" });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/class/:classId/file/:fileId', async (req, res) => {
    try {
        const { classId, fileId } = req.params;
        const classroom = await Classroom.findById(classId);
        if (!classroom) return res.status(404).json({ error: "Class not found" });
        const fileIndex = classroom.files.findIndex(f => f._id.toString() === fileId);
        if (fileIndex === -1) return res.status(404).json({ error: "File not found" });
        const filePath = classroom.files[fileIndex].path;
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        classroom.files.splice(fileIndex, 1);
        await classroom.save();
        res.json({ message: "File deleted" });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/reset', async (req, res) => {
    try {
        await User.deleteMany({});
        await Classroom.deleteMany({});
        res.send("Database Wiped!");
    } catch (err) { res.status(500).send(err.message); }
});

app.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));
const express = require('express');
const mongoose = require('mongoose');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');

const app = express();
const PORT = 3000;

// --- CONFIGURATION ---
const TEACHER_SECRET_CODE = "TEACHER2024";

// --- Middleware ---
app.use(cors()); // Allows the Flutter app to connect from a different "origin" (IP)
app.use(express.json());
app.use('/uploads', express.static('uploads'));

// --- MongoDB Atlas Connection ---
// 1. Log in to MongoDB Atlas -> Connect -> Drivers -> Node.js
// 2. Copy the connection string.
// 3. REPLACE the string below with yours. 
// 4. REPLACE <password> with your actual database password.
const MONGO_URI = "mongodb+srv://Irisszzss:abcd_1234@cluster0.hltihwn.mongodb.net/?appName=Cluster0";

mongoose.connect(MONGO_URI)
  .then(() => console.log("✅ MongoDB Connected to Cloud (Atlas)"))
  .catch(err => console.log("❌ MongoDB Connection Error:", err));

// --- Schemas ---
const UserSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    role: { type: String, enum: ['teacher', 'student'], required: true }
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

// --- File Upload Config ---
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = './uploads';
        if (!fs.existsSync(dir)) fs.mkdirSync(dir);
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + '-' + file.originalname);
    }
});
const upload = multer({ storage: storage });

// --- ROUTES ---

app.post('/register', async (req, res) => {
    const { username, password, role, secretCode } = req.body;
    try {
        if (role === 'teacher' && secretCode !== TEACHER_SECRET_CODE) {
            return res.status(403).json({ error: "Invalid Teacher Secret Code" });
        }
        const hashedPassword = await bcrypt.hash(password, 10);
        const newUser = new User({ username, password: hashedPassword, role });
        await newUser.save();
        res.json({ message: "Success", userId: newUser._id, role: newUser.role, name: newUser.username });
    } catch (err) {
        if (err.code === 11000) return res.status(400).json({ error: "Username taken." });
        res.status(500).json({ error: err.message });
    }
});

app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const user = await User.findOne({ username });
        if (!user) return res.status(400).json({ error: "User not found" });
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) return res.status(400).json({ error: "Invalid credentials" });
        res.json({ userId: user._id, role: user.role, name: user.username });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/create-class', async (req, res) => {
    const { name, teacherId } = req.body;
    const code = Math.random().toString(36).substring(2, 8).toUpperCase();
    try {
        const newClass = new Classroom({ name, teacherId, code, students: [], files: [] });
        await newClass.save();
        res.json(newClass);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
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
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/classes/:userId/:role', async (req, res) => {
    const { userId, role } = req.params;
    try {
        let classes;
        if (role === 'teacher') classes = await Classroom.find({ teacherId: userId });
        else classes = await Classroom.find({ students: userId });
        res.json(classes);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/upload/:classId', upload.single('pdf'), async (req, res) => {
    try {
        const classroom = await Classroom.findById(req.params.classId);
        if (!classroom) return res.status(404).json({ error: "Class not found" });
        classroom.files.push({ filename: req.file.originalname, path: req.file.path });
        await classroom.save();
        res.json({ message: "Success" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
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
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/class/:classId/file/:fileId', async (req, res) => {
    try {
        const { classId, fileId } = req.params;
        const { newName } = req.body;
        const classroom = await Classroom.findById(classId);
        
        const file = classroom.files.id(fileId);
        if (!file) return res.status(404).json({ error: "File not found" });

        file.filename = newName;
        await classroom.save();
        res.json({ message: "File renamed" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Resets database for testing
app.get('/reset', async (req, res) => {
    try {
        await User.deleteMany({});
        await Classroom.deleteMany({});
        res.send("Database Wiped!");
    } catch (err) {
        res.status(500).send(err.message);
    }
});

// 0.0.0.0 allows connections from external devices (your phone)
app.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));
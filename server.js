const express = require('express');
const mongoose = require('mongoose');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const TEACHER_SECRET_CODE = "TEACHER2024";

// --- Middleware ---
app.use(cors());
app.use(express.json());
const uploadDir = './uploads';
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
app.use('/uploads', express.static(uploadDir));

// --- MongoDB Connection ---
// ✅ UPDATED: Using your specific Atlas Connection String as default
const ATLAS_URI = "mongodb+srv://Irisszzss:abcd_1234@cluster0.hltihwn.mongodb.net/smartstroke?retryWrites=true&w=majority&appName=Cluster0";

// Check if we are in Cloud (Render) or Local. Use Atlas for both if Env var is missing.
const MONGO_URI = process.env.MONGO_URI || ATLAS_URI;

mongoose.connect(MONGO_URI)
  .then(() => console.log("✅ MongoDB Connected"))
  .catch(err => console.log("❌ MongoDB Connection Error:", err));

// --- Schemas ---
const UserSchema = new mongoose.Schema({
    firebaseUid: { type: String, required: true, unique: true },
    email: String,
    name: String,
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

// --- File Upload ---
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname.replace(/\s+/g, '_'))
});
const upload = multer({ storage: storage });

// --- ROUTES ---

// Auth Sync (Firebase -> MongoDB)
app.post('/auth/sync', async (req, res) => {
    const { firebaseUid, email, name, role, secretCode } = req.body;
    try {
        let user = await User.findOne({ firebaseUid });
        if (!user) {
            if (role === 'teacher' && secretCode !== TEACHER_SECRET_CODE) {
                return res.status(403).json({ error: "Invalid Teacher Secret Code" });
            }
            user = new User({ firebaseUid, email, name, role });
            await user.save();
        } 
        res.json(user);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Class & File Routes
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
        const fileIndex = classroom.files.findIndex(f => f._id.toString() === fileId);
        if (fileIndex === -1) return res.status(404).json({ error: "File not found" });
        
        const filePath = classroom.files[fileIndex].path;
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

        classroom.files.splice(fileIndex, 1);
        await classroom.save();
        res.json({ message: "File deleted" });
    } catch (err) { res.status(500).json({ error: err.message }); }
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
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));
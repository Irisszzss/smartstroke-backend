require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const app = express();
const PORT = process.env.PORT || 3000;
const TEACHER_SECRET_CODE = "TEACHER2024";

// --- Middleware ---
app.use(cors());
app.use(express.json());

// Ensure upload directory exists and serve it statically
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}
app.use('/uploads', express.static(uploadDir));

// --- MongoDB Connection ---
const MONGO_URI = process.env.MONGO_URI;

if (!MONGO_URI) {
    console.error("❌ MONGO_URI is missing! Check your .env file.");
} else {
    mongoose.connect(MONGO_URI)
        .then(() => console.log("✅ MongoDB Connected Successfully"))
        .catch(err => console.error("❌ MongoDB Connection Error:", err));
}

// --- Schemas ---
const UserSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true, trim: true, lowercase: true },
    email: { type: String, required: true, unique: true, trim: true, lowercase: true },
    password: { type: String, required: true },
    firstName: { type: String, required: true },
    middleInitial: { type: String, default: "" },
    surname: { type: String, required: true },
    role: { type: String, enum: ['teacher', 'student'], required: true },
    profilePicture: { type: String, default: "" }
}, { 
    toJSON: { virtuals: true }, 
    toObject: { virtuals: true },
    timestamps: true // ✅ Added Timestamps for User
});

UserSchema.virtual('name').get(function() {
    return `${this.firstName} ${this.middleInitial ? this.middleInitial + '. ' : ''}${this.surname}`;
});

const User = mongoose.model('User', UserSchema);

const ClassSchema = new mongoose.Schema({
    name: { type: String, required: true },
    teacherId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    code: { type: String, unique: true },
    students: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    files: [{
        filename: String,
        path: String, 
        uploadDate: { type: Date, default: Date.now } // Existing field
    }]
}, { 
    timestamps: true // ✅ Added Timestamps for Classroom
});

const Classroom = mongoose.model('Classroom', ClassSchema);

// --- File Upload Configuration ---
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
        const cleanName = file.originalname.replace(/\s+/g, '_');
        cb(null, `${Date.now()}-${cleanName}`);
    }
});
const upload = multer({ 
    storage: storage,
    limits: { fileSize: 10 * 1024 * 1024 } 
});

// --- ROUTES ---

// UPDATE USER PROFILE
app.put('/user/:userId', async (req, res) => {
    const { firstName, middleInitial, surname, username, email, password } = req.body;
    try {
        const user = await User.findById(req.params.userId);
        if (!user) return res.status(404).json({ error: "User not found" });

        if (username && username.toLowerCase() !== user.username) {
            const existing = await User.findOne({ username: username.toLowerCase() });
            if (existing) return res.status(400).json({ error: "Username taken" });
            user.username = username.toLowerCase();
        }

        if (email && email.toLowerCase() !== user.email) {
            const existing = await User.findOne({ email: email.toLowerCase() });
            if (existing) return res.status(400).json({ error: "Email taken" });
            user.email = email.toLowerCase();
        }

        if (firstName) user.firstName = firstName;
        if (middleInitial !== undefined) user.middleInitial = middleInitial;
        if (surname) user.surname = surname;

        if (password && password.trim() !== "") {
            user.password = await bcrypt.hash(password, 10);
        }

        await user.save();
        res.json({ 
            success: true, 
            userId: user._id,
            name: user.name,
            firstName: user.firstName,
            middleInitial: user.middleInitial,
            surname: user.surname,
            username: user.username,
            email: user.email,
            role: user.role,
            profilePicture: user.profilePicture
        });
    } catch (err) {
        res.status(500).json({ error: "Update failed: " + err.message });
    }
});

// UPLOAD PROFILE PICTURE
app.post('/user/:userId/avatar', upload.single('avatar'), async (req, res) => {
    try {
        const user = await User.findById(req.params.userId);
        if (!user) return res.status(404).json({ error: "User not found" });

        if (user.profilePicture) {
            const oldPath = path.join(__dirname, user.profilePicture);
            if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
        }

        const relativePath = `uploads/${req.file.filename}`;
        user.profilePicture = relativePath;
        await user.save();

        res.json({ success: true, profilePicture: relativePath });
    } catch (err) {
        res.status(500).json({ error: "Upload failed: " + err.message });
    }
});

app.post('/register', async (req, res) => {
    const { username, email, password, firstName, middleInitial, surname, role, secretCode } = req.body;
    try {
        const existingUser = await User.findOne({ $or: [{ username: username.toLowerCase() }, { email: email.toLowerCase() }] });
        if (existingUser) return res.status(400).json({ error: "Username or Email already exists" });

        if (role === 'teacher' && secretCode !== TEACHER_SECRET_CODE) {
            return res.status(403).json({ error: "Invalid Teacher Secret Code" });
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        const newUser = new User({ 
            username: username.toLowerCase(), 
            email: email.toLowerCase(), 
            password: hashedPassword, 
            firstName, 
            middleInitial, 
            surname, 
            role 
        });
        await newUser.save();

        res.json({ success: true, userId: newUser._id, name: newUser.name, role: newUser.role });
    } catch (err) {
        res.status(500).json({ error: "Registration failed: " + err.message });
    }
});

app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const user = await User.findOne({ 
            $or: [
                { username: username.toLowerCase() }, 
                { email: username.toLowerCase() }
            ] 
        });

        if (!user) return res.status(400).json({ error: "Account not found" });

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) return res.status(400).json({ error: "Invalid credentials" });

        res.json({ 
            success: true, 
            userId: user._id, 
            name: user.name,
            firstName: user.firstName,
            middleInitial: user.middleInitial,
            surname: user.surname,
            username: user.username,
            email: user.email,
            role: user.role,
            profilePicture: user.profilePicture
        });
    } catch (err) {
        res.status(500).json({ error: "Login failed" });
    }
});

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
        const classroom = await Classroom.findOne({ code: classCode.toUpperCase() });
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
        let classes = (role === 'teacher') 
            ? await Classroom.find({ teacherId: userId }) 
            : await Classroom.find({ students: userId });
        res.json(classes);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/class/:classId/students', async (req, res) => {
    try {
        const classroom = await Classroom.findById(req.params.classId);
        const students = await User.find({ _id: { $in: classroom.students } }, 'firstName surname username email profilePicture');
        res.json(students);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/class/:classId/remove-student', async (req, res) => {
    const { studentId } = req.body;
    try {
        const classroom = await Classroom.findById(req.params.classId);
        classroom.students = classroom.students.filter(id => id.toString() !== studentId);
        await classroom.save();
        res.json({ message: "Student removed" });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/upload/:classId', upload.single('pdf'), async (req, res) => {
    try {
        const classroom = await Classroom.findById(req.params.classId);
        const relativePath = `uploads/${req.file.filename}`;
        
        // Push object with metadata; uploadDate will still be there for safety
        classroom.files.push({ 
            filename: req.file.originalname, 
            path: relativePath,
            uploadDate: new Date() 
        });
        
        await classroom.save();
        // Return the full updated classroom or the specific file
        res.json({ message: "Success", file: classroom.files[classroom.files.length - 1] });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/class/:classId/file/:fileId', async (req, res) => {
    try {
        const { classId, fileId } = req.params;
        const classroom = await Classroom.findById(classId);
        const file = classroom.files.id(fileId);
        if (!file) return res.status(404).json({ error: "File not found" });

        const fullPath = path.join(__dirname, file.path);
        if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
        file.deleteOne();
        await classroom.save();
        res.json({ message: "File deleted" });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// server.js - Add this route
app.delete('/class/:classId', async (req, res) => {
    try {
        const { classId } = req.params;
        const classroom = await Classroom.findById(classId);
        
        if (!classroom) return res.status(404).json({ error: "Class not found" });

        // 1. Optional: Delete physical files from 'uploads' folder first
        if (classroom.files && classroom.files.length > 0) {
            classroom.files.forEach(file => {
                const fullPath = path.join(__dirname, file.path);
                if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
            });
        }

        // 2. Remove the class from database
        await Classroom.findByIdAndDelete(classId);
        
        res.json({ message: "Classroom and associated files deleted successfully" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/class/:classId/leave', async (req, res) => {
    try {
        const { classId } = req.params;
        const { studentId } = req.body;

        const classroom = await Classroom.findById(classId);
        if (!classroom) return res.status(404).json({ error: "Class not found" });

        // Remove the student ID from the array
        classroom.students = classroom.students.filter(id => id.toString() !== studentId);
        await classroom.save();

        res.json({ success: true, message: "You have left the class." });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/reset', async (req, res) => {
    try {
        await User.deleteMany({});
        await Classroom.deleteMany({});
        const files = fs.readdirSync(uploadDir);
        for (const file of files) fs.unlinkSync(path.join(uploadDir, file));
        res.send("Database and Files Wiped!");
    } catch (err) { res.status(500).send(err.message); }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 SmartStroke Server running on port ${PORT}`);
});
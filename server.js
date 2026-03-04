require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const http = require('http'); // HTTP server for Socket.io integration
const { Server } = require('socket.io'); // Socket.io server class

const app = express();
const server = http.createServer(app); // Create HTTP server using Express app
const io = new Server(server, {
    cors: {
        origin: "*", // Allows cross-origin requests from any frontend origin
        methods: ["GET", "POST"]
    }
});

const PORT = process.env.PORT || 3000;
const TEACHER_SECRET_CODE = "TEACHER2024";

// --- Middleware Configuration ---
app.use(cors());
app.use(express.json());

// Initialize file upload directory
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}
app.use('/uploads', express.static(uploadDir));

// --- MongoDB Database Connection ---
const MONGO_URI = process.env.MONGO_URI;

if (!MONGO_URI) {
    console.error("❌ MONGO_URI is missing! Check your .env file.");
} else {
    mongoose.connect(MONGO_URI)
        .then(() => console.log("✅ MongoDB Connected Successfully"))
        .catch(err => console.error("❌ MongoDB Connection Error:", err));
}

// --- Data Schemas & Models ---
const UserSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true, trim: true },
    email: { type: String, required: true, unique: true, trim: true },
    password: { type: String, required: true },
    firstName: { type: String, required: true },
    middleInitial: { type: String, default: "" },
    surname: { type: String, required: true },
    role: { type: String, enum: ['teacher', 'student'], required: true },
    profilePicture: { type: String, default: "" }
}, { 
    toJSON: { virtuals: true }, 
    toObject: { virtuals: true },
    timestamps: true 
});

// Virtual property for formatted full name
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
        uploadDate: { type: Date, default: Date.now }
    }]
}, { 
    timestamps: true 
});

const Classroom = mongoose.model('Classroom', ClassSchema);

// --- Multer File Storage Logic ---
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
        const cleanName = file.originalname.replace(/\s+/g, '_'); // Replace spaces with underscores
        cb(null, `${Date.now()}-${cleanName}`);
    }
});

const upload = multer({ 
    storage: storage,
    limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

// In-memory store for tracking live sessions
const activeStreams = {}; // Structure: { classId: teacherSocketId }

// --- Socket.io Real-time Event Handlers ---
io.on('connection', (socket) => {
    console.log('⚡ User connected:', socket.id);

    // 1. Join a specific classroom room
    socket.on('join-session', (classId) => {
        socket.join(classId);
        console.log(`👤 User joined classroom: ${classId}`);
    });

    // 2. Livestream State Management
    socket.on('start-stream', (classId) => {
        activeStreams[classId] = socket.id;
        io.to(classId).emit('stream-status', { isLive: true });
        // Notify external clients (e.g., Python CV script) that the board is available
        io.emit('board-available', classId); 
    });

    socket.on('stop-stream', (classId) => {
        if (activeStreams[classId] === socket.id) {
            delete activeStreams[classId];
            io.to(classId).emit('stream-status', { isLive: false });
        }
    });

    // 3. Computer Vision (Absolute Position) Data
    socket.on('transmit-cv-pos', (data) => {
        // Broadcasts absolute X/Y coordinates to students in the classroom
        socket.to(data.classId).emit('receive-cv-pos', { x: data.x, y: data.y });
    });

    // 4. Automation & Syncing
    socket.on('request-camera-sync', (classId) => {
        console.log(`📡 Broadcast: Camera sync requested for class ${classId}`);
        // Global broadcast as the receiver script might not be in a room yet
        io.emit('camera-auto-join', classId); 
    });

    socket.on('python-ping', () => {
        socket.emit('python-ready');
    });

    // 5. Drawing Stroke & Canvas Action Broadcasting
    socket.on('transmit-stroke', (data) => {
        socket.to(data.classId).emit('receive-stroke', data);
    });

    socket.on('transmit-action', (data) => {
        socket.to(data.classId).emit('receive-action', data);
    });

    // 6. Cleanup on User Disconnection
    socket.on('disconnect', () => {
        console.log('❌ User disconnected');
        for (const classId in activeStreams) {
            if (activeStreams[classId] === socket.id) {
                delete activeStreams[classId];
                io.to(classId).emit('stream-status', { isLive: false });
            }
        }
    });
});

// --- REST API Endpoints ---

// Update User Profile
app.put('/user/:userId', async (req, res) => {
    const { firstName, middleInitial, surname, username, email, password } = req.body;
    try {
        const user = await User.findById(req.params.userId);
        if (!user) return res.status(404).json({ error: "User not found" });

        if (username && username !== user.username) {
            const existing = await User.findOne({ username: username });
            if (existing) return res.status(400).json({ error: "Username taken" });
            user.username = username;
        }

        if (email && email !== user.email) {
            const existing = await User.findOne({ email: email });
            if (existing) return res.status(400).json({ error: "Email taken" });
            user.email = email;
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

// Upload User Avatar
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

// User Registration
app.post('/register', async (req, res) => {
    const { username, email, password, firstName, middleInitial, surname, role, secretCode } = req.body;
    try {
        const existingUser = await User.findOne({ $or: [{ username: username }, { email: email }] });
        if (existingUser) return res.status(400).json({ error: "Username or Email already exists" });

        if (role === 'teacher' && secretCode !== TEACHER_SECRET_CODE) {
            return res.status(403).json({ error: "Invalid Teacher Secret Code" });
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        const newUser = new User({ 
            username, 
            email,    
            password: hashedPassword, 
            firstName, 
            middleInitial, 
            surname, 
            role: role.toLowerCase()
        });
        await newUser.save();

        res.json({ success: true, userId: newUser._id, name: newUser.name, role: newUser.role });
    } catch (err) {
        res.status(500).json({ error: "Registration failed: " + err.message });
    }
});

// User Login
app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const user = await User.findOne({ 
            $or: [
                { username: username }, 
                { email: username }
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

// Create a New Classroom
app.post('/create-class', async (req, res) => {
    const { name, teacherId } = req.body;
    const code = Math.random().toString(36).substring(2, 8).toUpperCase();
    try {
        const newClass = new Classroom({ name, teacherId, code, students: [], files: [] });
        await newClass.save();
        res.json(newClass);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Join Classroom with Code
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

// Fetch Classes based on User Role
app.get('/classes/:userId/:role', async (req, res) => {
    const { userId, role } = req.params;
    try {
        let classes = (role === 'teacher') 
            ? await Classroom.find({ teacherId: userId }) 
            : await Classroom.find({ students: userId });
        res.json(classes);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Get Student List for a Class
app.get('/class/:classId/students', async (req, res) => {
    try {
        const classroom = await Classroom.findById(req.params.classId);
        const students = await User.find({ _id: { $in: classroom.students } }, 'firstName surname username email profilePicture');
        res.json(students);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Remove Student from Class
app.post('/class/:classId/remove-student', async (req, res) => {
    const { studentId } = req.body;
    try {
        const classroom = await Classroom.findById(req.params.classId);
        classroom.students = classroom.students.filter(id => id.toString() !== studentId);
        await classroom.save();
        res.json({ message: "Student removed" });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Upload PDF to Classroom
app.post('/upload/:classId', upload.single('pdf'), async (req, res) => {
    try {
        const classroom = await Classroom.findById(req.params.classId);
        const relativePath = `uploads/${req.file.filename}`;
        classroom.files.push({ 
            filename: req.file.originalname, 
            path: relativePath,
            uploadDate: new Date() 
        });
        await classroom.save();
        res.json({ message: "Success", file: classroom.files[classroom.files.length - 1] });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Delete specific file from a Classroom
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

// Delete Classroom and all its files
app.delete('/class/:classId', async (req, res) => {
    try {
        const { classId } = req.params;
        const classroom = await Classroom.findById(classId);
        if (!classroom) return res.status(404).json({ error: "Class not found" });

        if (classroom.files && classroom.files.length > 0) {
            classroom.files.forEach(file => {
                const fullPath = path.join(__dirname, file.path);
                if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
            });
        }

        await Classroom.findByIdAndDelete(classId);
        res.json({ message: "Classroom and associated files deleted successfully" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Remove User Avatar
app.delete('/user/:userId/avatar', async (req, res) => {
    try {
        const user = await User.findById(req.params.userId);
        if (!user) return res.status(404).json({ error: "User not found" });

        if (user.profilePicture) {
            const filePath = path.join(__dirname, user.profilePicture);
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        }

        user.profilePicture = "";
        await user.save();

        res.json({ success: true, message: "Avatar removed" });
    } catch (err) {
        res.status(500).json({ error: "Failed to remove avatar: " + err.message });
    }
});

// Student Leave Class
app.post('/class/:classId/leave', async (req, res) => {
    try {
        const { classId } = req.params;
        const { studentId } = req.body;
        const classroom = await Classroom.findById(classId);
        if (!classroom) return res.status(404).json({ error: "Class not found" });
        classroom.students = classroom.students.filter(id => id.toString() !== studentId);
        await classroom.save();
        res.json({ success: true, message: "You have left the class." });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// System Reset (Admin use only - wipes everything)
app.get('/reset', async (req, res) => {
    try {
        await User.deleteMany({});
        await Classroom.deleteMany({});
        const files = fs.readdirSync(uploadDir);
        for (const file of files) fs.unlinkSync(path.join(uploadDir, file));
        res.send("Database and Files Wiped!");
    } catch (err) { res.status(500).send(err.message); }
});

// --- Server Entry Point ---
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 SmartStroke Server with Streaming running on port ${PORT}`);
});
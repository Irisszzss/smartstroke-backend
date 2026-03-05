require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const sgMail = require('@sendgrid/mail');
const http = require('http'); 
const { Server } = require('socket.io'); 

const app = express();
const server = http.createServer(app); 
const io = new Server(server, {
    cors: {
        origin: "*", 
        methods: ["GET", "POST"]
    }
});

const PORT = process.env.PORT || 3000;

// --- Email Configuration (SendGrid) ---
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// --- Middleware Configuration ---
app.use(cors({
    origin: "*", 
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"]
}));
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
    profilePicture: { type: String, default: "" },
    isApproved: { type: Boolean, default: false }
}, { 
    toJSON: { virtuals: true }, 
    toObject: { virtuals: true },
    timestamps: true 
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
        uploadDate: { type: Date, default: Date.now }
    }]
}, { timestamps: true });

const Classroom = mongoose.model('Classroom', ClassSchema);

// --- Multer File Storage Logic ---
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
        const cleanName = file.originalname.replace(/\s+/g, '_');
        cb(null, `${Date.now()}-${cleanName}`);
    }
});
const upload = multer({ storage: storage, limits: { fileSize: 10 * 1024 * 1024 } });

// --- Socket.io Real-time Event Handlers ---
const activeStreams = {}; 

io.on('connection', (socket) => {
    socket.on('join-session', (classId) => socket.join(classId));

    socket.on('start-stream', (classId) => {
        activeStreams[classId] = socket.id;
        io.to(classId).emit('stream-status', { isLive: true });
        io.emit('board-available', classId); 
    });

    socket.on('stop-stream', (classId) => {
        if (activeStreams[classId] === socket.id) {
            delete activeStreams[classId];
            io.to(classId).emit('stream-status', { isLive: false });
        }
    });

    socket.on('transmit-cv-pos', (data) => socket.to(data.classId).emit('receive-cv-pos', { x: data.x, y: data.y }));
    socket.on('transmit-stroke', (data) => socket.to(data.classId).emit('receive-stroke', data));
    socket.on('transmit-action', (data) => socket.to(data.classId).emit('receive-action', data));

    socket.on('disconnect', () => {
        for (const classId in activeStreams) {
            if (activeStreams[classId] === socket.id) {
                delete activeStreams[classId];
                io.to(classId).emit('stream-status', { isLive: false });
            }
        }
    });
});

// --- REST API Endpoints ---

// 1. Authentication
app.post('/register', async (req, res) => {
    const { username, email, password, firstName, middleInitial, surname, role } = req.body;
    try {
        const existingUser = await User.findOne({ $or: [{ username }, { email }] });
        if (existingUser) return res.status(400).json({ error: "Username or Email already exists" });

        const hashedPassword = await bcrypt.hash(password, 10);
        const isTeacher = role.toLowerCase() === 'teacher';

        const newUser = new User({ 
            username, 
            email, 
            password: hashedPassword, 
            firstName, 
            middleInitial, 
            surname, 
            role: role.toLowerCase(),
            isApproved: !isTeacher 
        });

        await newUser.save();

        if (isTeacher) {
            const msg = {
                to: process.env.ADMIN_EMAIL,
                from: {
                    email: process.env.EMAIL_USER,
                    name: 'SmartStroke System' // Adding a name improves delivery trust
                },
                subject: 'SmartStroke: New Teacher Registration',
                html: `
                    <div style="font-family: sans-serif; padding: 20px; border: 1px solid #e2e8f0; border-radius: 12px;">
                        <h3 style="color: #001BB7;">Administrative Action Required</h3>
                        <p>A new educator, <b>${firstName} ${surname}</b> (${email}), has registered for an account.</p>
                        <p>This account is currently <b>pending</b>. Please access the Admin Directory to authorize or decline this request.</p>
                        <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;" />
                        <p style="font-size: 11px; color: #94a3b8;">Ref ID: ${newUser._id}</p>
                    </div>
                `
            };

            // Sent via SendGrid API to avoid Render port blocks
            sgMail.send(msg).catch(err => {
                console.error("Admin notification failed:", err.response?.body || err);
            });
        }

        res.json({ 
            success: true, 
            message: isTeacher 
                ? "Registration successful. Please wait for administrative approval." 
                : "Registration successful!",
            isApproved: newUser.isApproved 
        });
    } catch (err) {
        res.status(500).json({ error: "Registration failed: " + err.message });
    }
});

app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const user = await User.findOne({ 
            $or: [{ username: username }, { email: username }] 
        });

        if (!user) return res.status(400).json({ error: "Account not found" });

        if (user.role === 'teacher' && user.isApproved !== true) {
            return res.status(403).json({ 
                error: "Your account is pending admin approval." 
            });
        }

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) return res.status(400).json({ error: "Invalid credentials" });

        res.json({ 
            success: true, 
            userId: user._id, 
            username: user.username, 
            firstName: user.firstName, 
            surname: user.surname, 
            middleInitial: user.middleInitial, 
            name: user.name, 
            role: user.role,
            email: user.email,
            isApproved: user.isApproved,
            profilePicture: user.profilePicture
        });
    } catch (err) {
        res.status(500).json({ error: "Login failed" });
    }
});

// 2. User Profile Management
app.put('/user/:userId', async (req, res) => {
    const { firstName, middleInitial, surname, username, email, password } = req.body;
    try {
        const user = await User.findById(req.params.userId);
        if (!user) return res.status(404).json({ error: "User not found" });

        if (username && username !== user.username) {
            const existing = await User.findOne({ username });
            if (existing) return res.status(400).json({ error: "Username taken" });
            user.username = username;
        }
        if (email && email !== user.email) {
            const existing = await User.findOne({ email });
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
            username: user.username, 
            firstName: user.firstName, 
            surname: user.surname, 
            middleInitial: user.middleInitial, 
            name: user.name, 
            email: user.email,
            role: user.role, 
            profilePicture: user.profilePicture, 
            isApproved: user.isApproved 
        });
    } catch (err) { 
        res.status(500).json({ error: err.message }); 
    }
});

// 3. Classroom Management
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

app.post('/class/:classId/leave', async (req, res) => {
    const { userId } = req.body;
    try {
        const classroom = await Classroom.findById(req.params.classId);
        if (!classroom) return res.status(404).json({ error: "Classroom not found" });
        classroom.students = classroom.students.filter(id => id.toString() !== userId);
        await classroom.save();
        res.json({ success: true, message: "Successfully left the class" });
    } catch (err) { res.status(500).json({ error: "Internal server error" }); }
});

app.delete('/class/:classId', async (req, res) => {
    try {
        const result = await Classroom.findByIdAndDelete(req.params.classId);
        if (!result) return res.status(404).json({ error: "Classroom not found" });
        res.json({ success: true, message: "Classroom deleted" });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 4. Roster Management
app.get('/class/:classId/students', async (req, res) => {
    try {
        const classroom = await Classroom.findById(req.params.classId).populate('students', 'firstName surname username profilePicture');
        if (!classroom) return res.status(404).json({ error: "Classroom not found" });
        res.json(classroom.students);
    } catch (err) { res.status(500).json({ error: "Server error fetching students" }); }
});

app.post('/class/:classId/remove-student', async (req, res) => {
    const { userId } = req.body;
    try {
        const classroom = await Classroom.findById(req.params.classId);
        if (!classroom) return res.status(404).json({ error: "Classroom not found" });
        classroom.students = classroom.students.filter(id => id.toString() !== userId);
        await classroom.save();
        res.json({ success: true, message: "Student removed" });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 5. File Management
app.post('/upload/:classId', upload.single('pdf'), async (req, res) => {
    try {
        const classroom = await Classroom.findById(req.params.classId);
        const relativePath = `uploads/${req.file.filename}`;
        classroom.files.push({ filename: req.file.originalname, path: relativePath });
        await classroom.save();
        res.json({ message: "Success", file: classroom.files[classroom.files.length - 1] });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/class/:classId/file/:fileId', async (req, res) => {
    try {
        const classroom = await Classroom.findById(req.params.classId);
        if (!classroom) return res.status(404).json({ error: "Classroom not found" });
        const file = classroom.files.id(req.params.fileId);
        if (file) {
            const filePath = path.join(__dirname, file.path);
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
            classroom.files.pull(req.params.fileId);
            await classroom.save();
        }
        res.json({ success: true, message: "File deleted" });
    } catch (err) { res.status(500).json({ error: "Error deleting file" }); }
});

// 6. Admin Management
app.get('/admin/pending-teachers', async (req, res) => {
    try {
        const pending = await User.find({ role: 'teacher', isApproved: false }, 'firstName surname email username');
        res.json(pending);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/admin/approve-teacher', async (req, res) => {
    const { email } = req.body;
    try {
        const user = await User.findOneAndUpdate(
            { email, role: 'teacher' }, 
            { isApproved: true }, 
            { new: true }
        );

        if (!user) return res.status(404).json({ error: "Teacher record not found." });

        const msg = {
            to: user.email,
            from: process.env.EMAIL_USER, 
            subject: 'SmartStroke Account Approved',
            html: `
                <div style="font-family: sans-serif; max-width: 600px; margin: auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 16px;">
                    <h2 style="color: #001BB7;">Account Authorization Successful</h2>
                    <p>Dear <b>${user.firstName} ${user.surname}</b>,</p>
                    <p>Your educator account for the <b>SmartStroke</b> platform has been formally approved.</p>
                    <p>You may now proceed to log in and manage your digital classrooms.</p>
                    <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;" />
                    <p style="font-size: 12px; color: #64748b;">This is an automated notification from the SmartStroke Administrative System.</p>
                </div>
            `
        };

        sgMail.send(msg)
            .then(() => console.log(`📧 Approval email sent to: ${user.email}`))
            .catch(mailErr => console.error("❌ SendGrid Email Failed:", mailErr.response?.body || mailErr));
        
        res.json({ 
            success: true, 
            message: `Account for ${email} has been successfully authorized.` 
        });

    } catch (err) {
        console.error("ADMIN APPROVAL ERROR:", err);
        res.status(500).json({ error: "An internal server error occurred during authorization." });
    }
});

app.delete('/admin/decline-teacher/:email', async (req, res) => {
    try {
        const user = await User.findOneAndDelete({ email: req.params.email, isApproved: false });
        if (!user) return res.status(404).json({ error: "Request not found" });
        res.json({ success: true, message: `Registration for ${req.params.email} declined.` });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 7. System Utilities
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
    console.log(`🚀 SmartStroke Server running on port ${PORT}`);
});
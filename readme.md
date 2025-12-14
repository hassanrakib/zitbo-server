# ZITBO Server

Backend service for **ZITBO**, a real-time task and time-tracking web application.  
Handles authentication, task management, real-time synchronization, and productivity analytics.

---

> **Client Side Repo:** [https://github.com/hassanrakib/zitbo-client](https://github.com/hassanrakib/zitbo-client)

## 🧩 Summary

This server powers the core business logic of ZITBO by combining RESTful APIs with WebSocket communication.  
It ensures accurate time tracking, secure access control, and seamless multi-device synchronization, even during unexpected disconnections.

---

## 🛠️ Tech Stack

- Node.js
- Express.js
- MongoDB
- Socket.IO
- JWT
- Firebase Authentication
- MongoDB Aggregation Framework

---

## ⚙️ Core Responsibilities

- Secure user authentication and authorization
- Task creation, updates, and time-session management
- Real-time synchronization across multiple devices per user
- Reliable session handling during network interruptions
- Aggregation of daily and weekly productivity metrics

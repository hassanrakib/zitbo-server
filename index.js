// require express to create an express app
const express = require("express");
// require http module to create http server
const http = require("http");
// get Server class from socket.io to create socket.io server
const { Server } = require("socket.io");
// mongodb db
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
// allow cross origin resource sharing
const cors = require("cors");
// jsonwebtoken package for jwt token implementation
const jwt = require("jsonwebtoken");
// date functions
const { startOfToday } = require("date-fns");
// dot env package for .env file usage
require("dotenv").config();

// express app
const app = express();

// http server
const server = http.createServer(app);

// create socket.io server
const io = new Server(server, {
  cors: {
    origin: "http://localhost:5173",
  },
});

// PORT to run the server
const port = process.env.PORT || 5000;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASSWORD}@zitbo-1.8pinoyh.mongodb.net/?retryWrites=true&w=majority`;
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

// middlewares
app.use(cors());
app.use(express.json());

// socket server middlewares
// this is executed only for the first time at the time of connecting
io.use((socket, next) => {
  // get the token by removing the Bearer
  const token = socket.handshake?.auth?.token?.split(" ")[1];

  // verify token
  jwt.verify(token, process.env.ACCESS_TOKEN_SECRET, (err, decoded) => {
    if (err) {
      // call the next function with the err
      // this will prevent the socket being connect to the server
      // also emits "connect_error" event to the client
      next(err);
    } else {
      // add a property to the socket
      // that holds the decoded data (authentication payload) after verifying the token
      socket.decoded = decoded;
      next();
    }
  });
});

// verify jwt token that comes from client side with http request
function verifyJWT(req, res, next) {
  const authorizationHeader = req.headers?.authorization;

  // if no authorization header then the request is unauthorized
  if (!authorizationHeader)
    return res.status(401).send({ message: "Unauthorized Access" });

  // get the token only be removing the 'Bearer'
  const token = authorizationHeader.split(" ")[1];

  jwt.verify(token, process.env.ACCESS_TOKEN_SECRET, (err, decoded) => {
    // if err in verifying the token
    if (err) return res.status(403).send({ message: "Access Forbidden" });

    // if successful in verifying the token with the secret key
    req.decoded = decoded;
    // call the next handler of the route
    next();
  });
}

async function run() {
  try {
    // connect to db and get a message

    // connect the client to the server
    await client.connect();
    // send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log("You successfully connected to MongoDB!");

    // database and collections
    const db = client.db("zitbo-1_db-1");
    const users = db.collection("users");
    const tasks = db.collection("tasks");

    // ********************

    //  REST APIs that uses req res model

    // ********************

    // validate username by checking if username is unique
    app.get("/users/validate/:username", async (req, res) => {
      const username = req.params.username;

      // check if user exists in db
      const userFromDB = await users.findOne({ username });

      // if user exists
      if (userFromDB) return res.send({ username: true });

      // if user doesn't exist
      return res.send({ username: false });
    });

    // create user in db after successful signup to firebase
    app.post("/users", async (req, res) => {
      const newUser = req.body;

      const result = await users.insertOne(newUser);

      res.send(result);
    });

    // get user after successful sign in to firebase with verified email
    app.get("/users/:username", verifyJWT, async (req, res) => {
      const username = req.params.username;

      // check if user exists in db
      const userFromDB = await users.findOne({ username });

      res.send(userFromDB);
    });

    // after first time authentication
    // send back a signed JSON payload aka JWT token to client for later authorization in server
    app.get("/jwt", async (req, res) => {
      const username = req.query.username;

      const userFromDB = await users.findOne({ username });

      // check that the requested user exists in my db
      if (userFromDB) {
        // sign a token with the payload and secret key and some options
        const token = jwt.sign({ username }, process.env.ACCESS_TOKEN_SECRET, {
          expiresIn: "7d",
        });
        return res.send({ token });
      }

      res.status(403).send({ token: "" });
    });

    // ********************

    //  socket.io server implementation for bidirectional event based realtime communication

    // ********************

    io.on("connection", (socket) => {
      const username = socket.decoded?.username;
      console.log(`${username} connected`);

      // listen to the tasks:create event to save new task to db
      // and send response if successfuly saved
      socket.on("tasks:create", async (newTask, callback) => {
        // add doer (username of the user)
        newTask.doer = username;
        // add date of the task creation
        // mongodb stores dates that are created in BE as utc dates
        newTask.date = new Date();
        // insert the newTask to tasks collection
        const result = await tasks.insertOne(newTask);
        // if successful insertion
        if (result.acknowledged) {
          // response after successful operation
          callback({ success: "Successfuly created the new task" });

          // tasks collection changed after creating new task
          // so need to emit "tasks:change-by-create" event that we are listening in TaskList component
          // the listener of "tasks:change-by-create" emits the "tasks:read" event to get the tasks
          socket.emit("tasks:change-by-create");
        }
      });

      // listen to tasks:read event and get todays tasks for the doer
      // this listener recieves the activeTaskId
      // if no activeTaskId recieved, activeTaskId is assigned a default value of empty string
      socket.on("tasks:read", async (activeTaskId = "") => {
        // query with doer and today's date
        // get the all the tasks of today
        const query = { doer: username, date: { $gte: startOfToday() } };
        const cursor = tasks.find(query);
        const result = await cursor.toArray();

        // send an event to the client to recieve the result
        socket.emit("tasks:read", { tasks: result, activeTaskId });
      });

      // register the start time of a task's workedTimeSpan into db
      socket.on("workedTimeSpan:start", async (_id, callback) => {
        // filter the task by _id
        // get the task and update workedTimeSpans array
        const filter = { _id: new ObjectId(_id) };
        // create the workedTimeSpan object with startTime property to push in workedTimeSpans
        const workedTimeSpan = { startTime: new Date() };
        // push workedTimeSpan to the workedTimeSpans array of the task
        const result = await tasks.updateOne(filter, {
          $push: { workedTimeSpans: workedTimeSpan },
        });
        // if successfuly pushed
        if (result.modifiedCount) {
          // give a response otherwise error will happen after the timeout
          callback({ status: "OK", message: "Happy working!" });

          // tasks collection changed after a task document is modified
          // so need to emit "tasks:change" event that we are listening in TaskList component
          // the listener of "tasks:change" emits the "tasks:read" event to get the tasks
          // also, here we are sending the active task id that is what we recieved with the event above
          socket.emit("tasks:change", _id);
        }
      });

      // register the end time of a task's workedTimeSpan object into db
      socket.on(
        "workedTimeSpan:end",
        async (_id, lastTimeSpanIndex, endTime, callback) => {

          // filter the task by _id
          // get the task and update the workedTimeSpans array's last object's endTime
          const filter = { _id: new ObjectId(_id) };

          // add endTime property to the last workedTimeSpan object
          const endTimeProperty = `workedTimeSpans.${lastTimeSpanIndex}.endTime`;

          // do register the endTime of the task's workedTimeSpan
          const result = await tasks.updateOne(
            // filter the task from tasks
            filter,
            // add endTime property to the last object of workedTimeSpans array
            {
              $set: {
                // if endTime comes from client set endTime otherwise current date object
                [endTimeProperty]: endTime ? endTime : new Date(),
              },
            }
          );

          // if successfuly added endTime property
          if (result.modifiedCount) {
            // give a response
            callback({ status: "OK", message: "Work done!" });

            // tasks collection changed after a task document is modified
            // so need to emit "tasks:change" event that we are listening in TaskList component
            // the listener of "tasks:change" emits the "tasks:read" event to get the tasks
            socket.emit("tasks:change");
          }
        }
      );

      // when workedTimeSpan is in progress, that means endTime is not registered to the object
      // ex: workedTimeSpans: [....,{startTime: date}], endTime is not added to the object
      // when in rogress, we emit "workedTimeSpan:continue" event from client side every 1 second
      socket.on("workedTimeSpan:continue", () => {
        // after listening we emit "workedTimeSpan:continue" with the current time as the end time
        socket.emit("workedTimeSpan:continue", new Date());
      });

      // listen to socket disconnect event
      socket.on("disconnect", () => {
        console.log("disconnected user is ", username);
      });
    });
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Welcome to zitbo server!");
});

// listen to the port from http server
server.listen(port, () => {
  console.log(`Zitbo server is running in port ${port}`);
});

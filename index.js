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
const { startOfToday, subDays, parseISO } = require("date-fns");
// dot env package for .env file usage
require("dotenv").config();

// express app
const app = express();

// http server
const server = http.createServer(app);

// create socket.io server
const io = new Server(server, {
  cors: {
    origin: process.env.LOCAL_HOST,
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

      // listen to "tasks:delete" event to delete a task from the tasks collection
      socket.on("tasks:delete", async (_id, activeTaskId, callback) => {
        // query to find the specified task with its _id
        const query = { _id: new ObjectId(_id) };

        // delete
        const result = await tasks.deleteOne(query);

        if (result.deletedCount === 1) {
          // call the callback after successfuly deleted the task
          callback({ status: "OK", message: "Successfully deleted the task!" });

          // tasks collection changed after a task document is deleted
          // so need to emit "tasks:change" event that we are listening in TaskList component
          // the listener of "tasks:change" emits the "tasks:read" event to get the tasks
          // also, here we are sending the active task id that is what we recieved with the event above
          socket.emit("tasks:change", activeTaskId);
        }
      })

      // update the taskName
      socket.on("taskName:update", async (_id, updatedTaskName, activeTaskId, callback) => {
        // filters the task by _id
        const filter = { _id: new ObjectId(_id) };

        // update
        const result = await tasks.updateOne(filter, { $set: { name: updatedTaskName } });

        // if successfully updated the task name
        if (result.modifiedCount) {
          // tasks collection changed after a task document is modified
          // so need to emit "tasks:change" event that we are listening in TaskList component
          // the listener of "tasks:change" emits the "tasks:read" event to get the tasks
          // also, here we are sending the active task id that is what we recieved with the event above
          socket.emit("tasks:change", activeTaskId);
          callback({ status: "OK", message: "Successfully updated the task name!" });
        }
      })

      // register the start time of a task's workedTimeSpan into db
      socket.on("workedTimeSpan:start", async (_id, callback) => {
        // filter the task by _id
        // get the task and update workedTimeSpans array
        const filter = { _id: new ObjectId(_id) };
        // create the workedTimeSpan object with startTime property to push in workedTimeSpans
        const workedTimeSpan = { _id: new ObjectId(), startTime: new Date() };
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

      // register the endTime of a task's workedTimeSpan object
      socket.on(
        "workedTimeSpan:end",
        async (_id, workedTimeSpanId, endTime, callback) => {
          // find the specified workedTimeSpan object in a specified task that we will add endTime
          // _id helps to find the specified task
          // "workedTimeSpans._id" here "workedTimeSpans" is the array that contains objects with "_id" property
          // "workedTimeSpans._id" returns matched object whose _id is ObjectId(workedTimeSpanId)
          const filter = { _id: new ObjectId(_id), "workedTimeSpans._id": new ObjectId(workedTimeSpanId) };

          // add endTime property to the matched workedTimeSpan object
          // here $ is the positional operator that refers the matched workedTimeSpan object
          const endTimeProperty = `workedTimeSpans.$.endTime`;

          // do register the endTime of the task's workedTimeSpan
          const result = await tasks.updateOne(
            // filter the specified workedTimeSpan in a specified task
            filter,
            // add endTime property to the matched workedTimeSpan object of workedTimeSpans array
            {
              $set: {
                // if endTime comes from client set endTime otherwise current date object
                [endTimeProperty]: endTime ? endTime : new Date(),
              },
            }
          );

          // if successfuly added endTime property
          if (result.modifiedCount) {
            // create an instantly resolved promise
            // so that, we can call callback first then emit "tasks:change" event 
            await Promise.resolve(
              // give a response
              callback({ status: "OK", message: "Work done!" })
            ).then(() => {
              // tasks collection changed after a task document is modified
              // so need to emit "tasks:change" event that we are listening in TaskList component
              // the listener of "tasks:change" emits the "tasks:read" event to get the tasks
              socket.emit("tasks:change");
            });
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

      // remove specified task's specified workedTimeSpan objects from workedTimeSpans array
      // to specify workedTimeSpan objects, we are using their _ids.
      socket.on("workedTimeSpan:delete", async (_id, workedTimeSpansIds, activeTaskId) => {

        // create workedTimeSpansObjectIds array from workedTimeSpansIds
        const workedTimeSpansObjectIds = workedTimeSpansIds.map(workedTimeSpanId => new ObjectId(workedTimeSpanId));

        // filter the task by _id
        // get the task and update workedTimeSpans array
        const filter = { _id: new ObjectId(_id) };

        // remove workedTimeSpan objects whose _id exists in workedTimeSpansObjectIds array
        const result = await tasks.updateOne(filter, {
          // $pull operator removes elements
          // workedTimeSpans is the array name
          // _id is the property to match for each array element
          // $in operator takes an array of ObjectId to check that element's _id is in it or not
          $pull: { workedTimeSpans: { _id: { $in: workedTimeSpansObjectIds } } },
        });

        // if successfuly deleted the last workedTimeSpan object
        if (result.modifiedCount) {
          // tasks collection changed after a task document is modified
          // so need to emit "tasks:change" event that we are listening in TaskList component
          // the listener of "tasks:change" emits the "tasks:read" event to get the tasks
          socket.emit("tasks:change", activeTaskId);
        }
      });

      // get an array of total completed times for a date range
      socket.on("totalCompletedTimes:read", async (lastTaskDate, daysToSubtract, callback) => {
        // endDate is the date object that is derived from the lastTaskDate string
        const endDate = parseISO(lastTaskDate);

        // subtract the number of days that we recieve in daysToSubtract parameter
        const dateAfterSubtraction = subDays(endDate, daysToSubtract);

        // get startDate from dateAfterSubtraction
        // by setting hours minutes seconds and milliseconds to 0
        const startDate = new Date(dateAfterSubtraction.setUTCHours(0, 0, 0, 0));

        // aggregation to get an array of total completed times between startDate and endDate
        const result = await tasks.aggregate([
          // filter out the tasks for a specific user and between startDate and endDate
          { $match: { doer: username, date: { $gte: startDate, $lte: endDate } } },
        ]).toArray();


        console.log(result);
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

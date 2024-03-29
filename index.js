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
  // get the token by removing the "Bearer"
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
    console.log("successfully connected to mongodb...");

    // database and collections
    const db = client.db("zitbo-1_db-1");
    // users collection contains registered users
    const users = db.collection("users");
    // tasks collection contains created tasks by different users
    const tasks = db.collection("tasks");
    // roomsStates collection contains states of different rooms
    const roomsStates = db.collection("roomsStates");

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
      console.log(`${username} connected...`);

      // if the same user uses multiple devices
      // for every device a new socket instance will be connected to the server
      // now here we join every socket instances of the same user to a specific room
      // so that we can broadcast event to that room to send data to multiple devices of the same user
      // the room name is the username of the user
      socket.join(username);

      // update state of a room
      // we will use the room's state that is stored in db
      // to send necessary information to the newly connected socket to the same room
      // for now, we are updating activeTaskId
      socket.on("roomState:update", async (activeTaskId, callback) => {
        // filter out specific room's state
        const filter = { room: username };
        // instruct updateOne method to create a document if no document matched the filter
        const options = { upsert: true }
        // new state
        const updateState = {
          $set: {
            // set activeTaskId of the room state
            // activeTaskId will be null when activeTaskId sent as undefined
            activeTaskId: activeTaskId || "",
          }
        };

        // updateOne operaton
        const result = await roomsStates.updateOne(filter, updateState, options);

        // if successfuly updated the room state
        if (result.acknowledged) {
          callback({ status: "OK", message: "Room states updated!" });
        }
      });

      socket.on("roomState:read", async (callback) => {
        // query to find the room state
        const query = { room: username };

        // find the room state
        const roomState = await roomsStates.findOne(query);

        // if room state found in db call the callback with the room state
        if (roomState) {
          callback(roomState);
        }
      })

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
          // so need to emit "tasks:change" event that we are listening in useTasksOfDays hook
          // the listener of "tasks:change" emits the "tasks:read" event to get the tasks
          // here we are sending indexInTasksOfDays as 0, because every task is created for the current date
          // and current date's tasks are in the first object of the tasksOfDays

          // emit event to the username room so that multiple devices (sockets) of the same user gets the event
          io.to(username).emit("tasks:change", 0);
        }
      });

      // listen to tasks:read event and get a day's tasks of a user
      // this listener recieves the startDate and endDate of a day in utc date string
      socket.on("tasks:read", async (startDateString, endDateString, callback) => {

        // query with doer and date
        // get the all the tasks between startDateString and endDateString 
        const query = { doer: username, date: { $gte: new Date(startDateString), $lte: new Date(endDateString) } };
        const cursor = tasks.find(query);
        const result = await cursor.toArray();

        // call the callback to recieve the result in the client side
        callback({ tasks: result });
      });

      // listen to "tasks:delete" event to delete a task from the tasks collection
      socket.on("tasks:delete", async (_id, isTaskActive, indexInTasksOfDays, callback) => {
        // query to find the specified task with its _id
        const query = { _id: new ObjectId(_id) };

        // delete
        const result = await tasks.deleteOne(query);

        if (result.deletedCount === 1) {
          // call the callback after successfuly deleted the task
          callback({ status: "OK", message: "Successfully deleted the task!" });

          // tasks collection changed after a task document is deleted
          // so need to emit "tasks:change" event that we are listening in useTasksOfDays hook
          // the listener of "tasks:change" emits the "tasks:read" event to get the tasks
          // if the task is active (isTaskActive >> true), after delete there will be no activeTaskId
          // that's why sending empty string for activeTaskId. otherwise sending undefined to not change activeTaskId state

          // emit event to the username room so that multiple devices (sockets) of the same user gets the event
          io.to(username).emit("tasks:change", indexInTasksOfDays, isTaskActive ? "" : undefined);
        }
      })

      // update the taskName
      socket.on("taskName:update", async (_id, updatedTaskName, indexInTasksOfDays, callback) => {
        // filters the task by _id
        const filter = { _id: new ObjectId(_id) };

        // update
        const result = await tasks.updateOne(filter, { $set: { name: updatedTaskName } });

        // if successfully updated the task name
        if (result.modifiedCount) {
          // tasks collection changed after a task document is modified
          // so need to emit "tasks:change" event that we are listening in useTasksOfDays hook
          // the listener of "tasks:change" emits the "tasks:read" event to get the tasks

          // emit event to the username room so that multiple devices (sockets) of the same user gets the event
          io.to(username).emit("tasks:change", indexInTasksOfDays);
          callback({ status: "OK", message: "Successfully updated the task name!" });
        }
      })

      // register the start time of a task's workedTimeSpan into db
      socket.on("workedTimeSpan:start", async (_id, indexInTasksOfDays, callback) => {
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
          // so need to emit "tasks:change" event that we are listening in useTasksOfDays hook
          // the listener of "tasks:change" emits the "tasks:read" event to get the tasks
          // also, here we are sending the activeTaskId that is what we recieved as _id with the event above

          // emit event to the username room so that multiple devices (sockets) of the same user gets the event
          io.to(username).emit("tasks:change", indexInTasksOfDays, _id);
        }
      });

      // register the endTime of a task's workedTimeSpan object
      // indexInTasksOfDays is the index of the object in the tasksOfDays state
      socket.on(
        "workedTimeSpan:end",
        async (_id, workedTimeSpanId, endTime, wasDisconnected, indexInTasksOfDays, callback) => {
          // send response using this function
          // by default activeTaskId is set to empty string
          // that means if activeTaskId sent as undefined or not sent then activeTaskId will be empty string
          async function sendResponse(activeTaskId = "") {
            // create an instantly resolved promise
            // so that, we can call callback first then emit "tasks:change" event 
            await Promise.resolve(
              // give a response
              callback({ status: "OK", message: "Work done!" })
            ).then(() => {
              // tasks collection changed after a task document is modified
              // so need to emit "tasks:change" event that we are listening in useTasksOfDays hook
              // the listener of "tasks:change" emits the "tasks:read" event to get the tasks
              // check if indexInTasksOfDays greater than or equals to 0 because useTasksOfDays hook checks localStorage for endTime
              // and if endTime exist it emits "workedTimeSpan:end" event
              // sending indexInTasksOfDay as -1 then read tasks without listening tasks:change event
              if (indexInTasksOfDays >= 0) {
                // emit event to the username room so that multiple devices (sockets) of the same user gets the event
                io.to(username).emit("tasks:change", indexInTasksOfDays, activeTaskId);
              }
            });
          }

          // find the specified task with specified workedTimeSpan object in its workedTimeSpans array
          // _id helps to find the specified task
          // "workedTimeSpans" is the array that contains objects with "_id" property
          // "workedTimeSpans._id" ensures that the specified workedTimeSpan object 
          // whose _id is ObjectId(workedTimeSpanId) is present in the task's workedTimeSpans array
          const filter = { _id: new ObjectId(_id), "workedTimeSpans._id": new ObjectId(workedTimeSpanId) };

          // but, before adding endTime to the workedTimeSpan object
          // the scenerio below needs to be handled
          // scenerio: one user is connected from two devices means two sockets in the same room
          // now, if one device goes offline, it will save endTime in localStorage
          // and if user doesn't leave the application when the device is offline
          // application will continuously try to save the endTime in localStorage to database
          // as soon as the device gets reconnected, 'workedTimeSpan:end' event will be emitted from the application.
          // but on the oterhand, another device that is connected can already register endTime
          // so, to avoid the reconnection to update endTime again checking is needed

          // another case: the connected device still kept the task active that means it didn't register
          // endTime to the database
          // but reconnection from disconnected device will try to save the endTime in localStorage to db
          // so, to avoid the reconnecion to register endTime
          // we check whether room state contains activeTaskId
          // note that we delete room state when there is no socket in the room (in this case activeTaskId will be undefined)
          // we clear activeTaskId in room state when workedTimeSpan:end successfuly registers endTime
          // if room state has activeTaskId that means another socket of the same user kept the task
          // active no need to register endTime from reconnected device
          const roomState = await roomsStates.findOne({ room: username });
          const activeTaskId = roomState?.activeTaskId;

          // get the specified task with only that workedTimeSpan object
          // in workedTimeSpans array of the task which matches workedTimeSpanId
          // the second parameter is a projection that keeps only the matched workedTimeSpan in workedTimeSpans array
          // output: {_id: "", name: "", workedTimeSpans: [{matchedWorkedTimeSpan}]}
          const task = await tasks.findOne(filter, {projection: {"workedTimeSpans.$": 1}});

          // we may delete the task or task's any workedTimeSpan
          // in this scenerio, we may try to save that endTime to db taking it from localStorage
          // if the task is not found task is null
          // if its null or no workedTimeSpan in the workedTimeSpans array

          // or matched workedTimeSpan's endTime property exists where we want to register endTime
          // or the socket was disconnected and the socket room state has activeTaskId
          // we don't allow registering endTime
          if ( !task || task.workedTimeSpans.length === 0 || task.workedTimeSpans[0].endTime || (wasDisconnected && activeTaskId)) {
            // return from here to avoid registering endTime
            return sendResponse(activeTaskId);
          }

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
                [endTimeProperty]: endTime ? new Date(endTime) : new Date(),
              },
            }
          );

          // if successfuly added endTime property
          if (result.modifiedCount) {
            sendResponse();
          }
        }
      );

      // when workedTimeSpan is in progress, that means endTime is not registered to the object
      // ex: workedTimeSpans: [....,{startTime: date}], endTime is not added to the object
      // when in rogress, we emit "workedTimeSpan:continue" event from client side every 1 second
      // and send startTime that we have in the last workedTimeSpan object of the workedTimeSpans array
      socket.on("workedTimeSpan:continue", (startTime) => {
        // after listening we emit "workedTimeSpan:continue" with the current time as the end time
        // also send back the startTime that we recieved with the event
        socket.emit("workedTimeSpan:continue", startTime, new Date());
      });

      // remove specified task's specified workedTimeSpan objects from workedTimeSpans array
      // to specify workedTimeSpan objects, we are using their _ids.
      socket.on("workedTimeSpan:delete", async (_id, workedTimeSpansIds, indexInTasksOfDays) => {

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
          // so need to emit "tasks:change" event that we are listening in useTasksOfDays hook
          // the listener of "tasks:change" emits the "tasks:read" event to get the tasks

          // emit event to the username room so that multiple devices (sockets) of the same user gets the event
          io.to(username).emit("tasks:change", indexInTasksOfDays);
        }
      });

      // get an array of total completed times for a date range
      socket.on("totalCompletedTimes:read", async (startDateString, endDateString, numberOfDaysCompletedTimes, timeZone, callback) => {

        // convert utc date strings to date objects
        const startDate = new Date(startDateString);
        const endDate = new Date(endDateString);

        // aggregation to get an array of total completed times between startDate and endDate
        const completedTimes = await tasks.aggregate([
          {
            $facet: {
              "existingDatesCompletedTimes": [
                // filter out the tasks for a specific user and between startDate and endDate
                { $match: { doer: username, date: { $gte: startDate, $lte: endDate } } },
                // project stage removes all the fields from a document
                // then adds a new localDate field to every document
                // it contains the converted date field value from utc date obj to
                // user's local timezone's date string like "2023-07-11" 
                // then adds another new field named completedTime (that holds time in millisecond)
                // $sum operator sums up all the number type elements in the array
                // $map converts workedTimeSpans array field that was containing objects like
                // {startTime: date, endTime: date} to an array of numbers.
                // by using $dateDiff to calculate difference in millisecond between startTime & endTime
                {
                  $project: {
                    _id: false,
                    localDate: {
                      $dateToString: {
                        format: "%Y-%m-%d", date: "$date", timezone: timeZone
                      }
                    },
                    completedTime: {
                      $sum: {
                        $map: {
                          input: '$workedTimeSpans',
                          as: 'workedTimeSpan',
                          in: {
                            $dateDiff: {
                              startDate: "$$workedTimeSpan.startTime",
                              endDate: "$$workedTimeSpan.endTime",
                              unit: "millisecond"
                            }
                          }
                        }
                      }
                    }
                  }
                },
                // $group stage groups all documents by localDate
                // like, for every document that has "2023-07-11" localDate, $group operator will return
                // a single document ex: {_id: "2023-07-11", completedTime: timeInMillisecond}
                // here completedTime field contains the sum of completedTime field value of every
                // document that has "2023-07-11" date
                {
                  $group: {
                    _id: "$localDate",
                    completedTime: {
                      $sum: "$completedTime"
                    }
                  }
                },
                // remove _id property
                // add localDate property and assign the _id property value to it
                // keep completedTime property
                {
                  $project: {
                    _id: false,
                    localDate: "$_id",
                    completedTime: true
                  }
                }
              ]
            }
          },
          // $project stage removes _id from the document
          // keeps existingDatesCompletedTimes array
          // creates a new array of allDatesInitialCompletedTimes
          // allDatesInitialCompletedTimes creation steps:
          // declare some variables inside $let operator's vars,
          // 1. numberOfDaysCompletedTimes holds a number of how many days completed times we want (we actually recieve it from client side)
          // 2. startDateInMs holds the converted startDate in millisecond, $toLong converts the date to ms
          // 3. oneDayInMs, holds the number of milliseconds for a day
          // use the variable declared in "vars" inside "in".
          // $map operator's input array is [0, 1, 2, 3, ...to the numberOfDaysCompletedTimes(excluded)] created using $range
          // named every array element as 'index'
          // modifies every array element inside 'in' of the $map,
          // declared more variables inside $let operator's vars
          // currentDateInMs holds a calculated value where we add startDateInMs to the multiplication of index and oneDayInMs
          // ex1: first array element is 0. first currentDateInMs is: 0 * oneDayInMs = 0, startDateInMs + 0 = startDateInMs
          // ex2: second array element is 1. second currentDateInMs is: 1 * oneDayInMs = oneDayInMs, startDateInMs + onDayInMs = secondDateInMs
          // then, we use currentDateInMs variable inside 'in' of the $let operator to get
          // localDate, where $toDate converts the currentDateInMs to date object
          // and add another new property completedTime set to 0
          // final output: {exstingDatesCompletedTimes, allDatesCompletedTimes: [{localDate:'fromStart', completedTime: 0}...{localDate:'toEndInSerial', completedTime: 0}]}
          {
            $project: {
              existingDatesCompletedTimes: "$existingDatesCompletedTimes",
              allDatesInitialCompletedTimes: {
                $let: {
                  vars: {
                    numberOfDaysCompletedTimes: numberOfDaysCompletedTimes,
                    startDateInMs: { $toLong: startDate },
                    oneDayInMs: 24 * 60 * 60 * 1000
                  },
                  in: {
                    $map: {
                      input: { $range: [0, "$$numberOfDaysCompletedTimes"] },
                      as: "index",
                      in: {
                        $let: {
                          vars: {
                            currentDateInMs: { $add: ["$$startDateInMs", { $multiply: ["$$index", "$$oneDayInMs"] }] },
                          },
                          in: {
                            localDate: {
                              $dateToString: {
                                format: "%Y-%m-%d", date: { $toDate: "$$currentDateInMs" }, timezone: timeZone
                              }
                            },
                            completedTime: 0,
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          },
          // $project stage merges existingDatesCompletedTimes and allDatesInitialCompletedTimes to a single array named allDatesCompletedTimes
          // firstly $map takes 'allDatesInitialCompletedTimes' as input array
          // then modifies it inside 'in' of the $map ($$this is used to refer every array element of the input array)
          // $cond takes an expression first and two values at the end inside an array
          // first expression is the condition that resolves to a boolean value
          // $in takes a value and an array. if the value is present in the array, returns true.
          // if true, $arrayElemAt takes an array as the first value and index as the second value to return the element from the array
          // $indexOfArray takes an array and a value to return the index.
          // if the condition evaluates to false, return $$this. 
          {
            $project: {
              allDatesCompletedTimes: {
                $map: {
                  input: "$allDatesInitialCompletedTimes",
                  in: {
                    $cond: [
                      { $in: ["$$this.localDate", "$existingDatesCompletedTimes.localDate"] },
                      {
                        $arrayElemAt: [
                          "$existingDatesCompletedTimes",
                          {
                            $indexOfArray: [
                              "$existingDatesCompletedTimes.localDate",
                              "$$this.localDate"
                            ]
                          }
                        ]
                      },
                      "$$this"
                    ]
                  }
                }
              }
            }
          }
        ]).toArray();

        // after getting completedTimes call the callback
        callback(completedTimes);
      });

      // get the dates that have tasks created by the user
      socket.on("existingDates:read", async (timeZone, callback) => {
        const existingDates = await tasks.aggregate([
          // match stage filters the tasks collection and gets user's tasks
          {
            $match: { doer: username }
          },
          // convert utc dates in date property of every document to local date string using the timezone that we recieve
          // remove _id property from every document
          // output documents {date: utcDate, localDate: "2023-08-01"}
          {
            $project: {
              _id: false,
              date: true,
              localDate: {
                $dateToString: {
                  format: "%Y-%m-%d", date: "$date", timezone: timeZone
                }
              },
            }
          },
          // group same localDates documents to single one
          // keep the first matched document's date
          // output documents {_id: "2023-08-01", date: utcDate}
          {
            $group: {
              _id: "$localDate",
              date: { $first: "$date" }
            }
          },
          // sort input documents by date in descending order
          {
            $sort: { date: -1 }
          },
          // create a single document using _id: null
          // and push all the input documents _id (that holds local date string)
          // to the localDates property of the single document
          // output document {_id: null, localDates: ["2023-08-01", ...]}
          {
            $group: {
              _id: null,
              localDates: {
                $push: "$_id"
              }
            }
          }

        ]).toArray();

        // send the data to client side
        callback(existingDates);
      });

      // listen to socket disconnect event
      socket.on("disconnect", () => {
        console.log(`${username} disconnected...`);

        // delete a room state
        async function deleteARoomState() {
          // get the number of sockets(users) in a room
          const numberOfSocketsInARoom = io.of("/").adapter.rooms.get(username)?.size;

          // if no socket(user) in a room
          if (!numberOfSocketsInARoom) {
            // then delete the room state

            // filters out the room state
            const query = { room: username };

            // do the delete operation
            await roomsStates.deleteOne(query);
          }
        }

        deleteARoomState();
      });
    });
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send({status: "OK", message: "server up and running!"});
});

// listen to the port from http server
server.listen(port, () => {
  console.log(`server is running in port ${port}...`);
});

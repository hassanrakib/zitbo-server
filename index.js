const express = require("express");
const { MongoClient, ServerApiVersion } = require("mongodb");
const cors = require("cors");
const jwt = require("jsonwebtoken");
require("dotenv").config();
const port = process.env.PORT || 5000;

const app = express();
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

    // APIs

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
    app.get("/users/:username", async (req, res) => {
      const username = req.params.username;

      // check if user exists in db
      const userFromDB = await users.findOne({ username });

      res.send(userFromDB);
    });

    // after first time authentication
    // send back a signed JSON payload aka JWT token to client for later authorization in server
    app.post("/jwt", async (req, res) => {
      const userFromClient = req.body;

      const userFromDB = await users.findOne({username: userFromClient.username});

      if(userFromDB) {
        const token = jwt.sign({username: userFromDB.username}, process.env.ACCESS_TOKEN_SECRET, {expiresIn: "7d"});
        res.send({token});
      }
    })
    


  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Welcome to zitbo server!");
});

app.listen(port, () => {
  console.log(`Zitbo server is running in port ${port}`);
});

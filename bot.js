//
// This is main file containing code implementing the Express server and functionality for the Express echo bot.
//
const express = require('express')
const bodyParser = require('body-parser')
const request = require('request')
const path = require('path')
const products = require('./products')

// Setting up Firebase
const admin = require("firebase-admin")
admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECTID,
    clientEmail: process.env.FIREBASE_CLIENTEMAIL,
    privateKey: process.env.FIREBASE_PRIVATEKEY.replace(/\\n/g, '\n')
  }),
  databaseURL: `https://${process.env.FIREBASE_PROJECTID}.firebaseio.com`
})

const database = admin.database()

const messengerButton = "<html><head><title>Botting Marco</title></head><body><h1>Botting Marco</h1>This is a bot based on Messenger Platform QuickStart. For more details, see their <a href=\"https://developers.facebook.com/docs/messenger-platform/guides/quick-start\">docs</a>.<script src=\"https://button.glitch.me/button.js\" data-style=\"glitch\"></script><div class=\"glitchButton\" style=\"position:fixed;top:20px;right:20px;\"></div></body></html>"

// The rest of the code implements the routes for our Express server.
let app = express()

app.use(bodyParser.json())
app.use(bodyParser.urlencoded({
  extended: true
}))

// Webhook validation
app.get('/webhook', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' &&
      req.query['hub.verify_token'] === process.env.VERIFY_TOKEN) {
    console.log("Validating webhook")
    res.status(200).send(req.query['hub.challenge'])
  } else {
    console.error("Failed validation. Make sure the validation tokens match.")
    res.sendStatus(403)
  }
})

// Display the web page
app.get('/', (req, res) => {
  res.writeHead(200, {'Content-Type': 'text/html'})
  res.write(messengerButton)
  res.end()
})

app.get('/privacy', (req, res) => {
  res.sendFile(__dirname + '/privacy.html')
})

// Message processing
app.post('/webhook', (req, res) => {
  console.log(req.body)
  const data = req.body

  // Make sure this is a page subscription
  if (data.object === 'page') {
    
    // Iterate over each entry - there may be multiple if batched
    data.entry.forEach(entry => {
      const pageID = entry.id
      const timeOfEvent = entry.time

      // Iterate over each messaging event
      entry.messaging.forEach(event => {
        if (event.message) 
          receivedMessage(event)
        else if (event.postback) 
          console.log("received postback message")//receivedPostback(event) 
        else 
          console.log(`Webhook received unknown event: ${event}`)
      })
    })

    // Assume all went well.
    //
    // You must send back a 200, within 20 seconds, to let the FB guys know
    // you've successfully received the callback. Otherwise, the request
    // will time out and they will keep trying to resend.
    res.sendStatus(200)
  }
})

// Incoming events handling, it simply prints to the console some data 
// and checks if this is the first chat from that user.
function receivedMessage(event) {
  const senderID = event.sender.id
  const recipientID = event.recipient.id
  const timeOfMessage = event.timestamp
  const message = event.message
  
  sendSenderAction(senderID, "mark_seen")
  sendSenderAction(senderID, "typing_on")

  console.log("Received message for user %d and page %d at %d with message:", 
    senderID, recipientID, timeOfMessage)
  console.log(JSON.stringify(message))
  
  const userRef = database.ref(`user/${senderID}`)
  userRef.once("value", snapshot => {
    if(!snapshot.exists()){
      storeUserData(event, ()=>storeMessageInitial(event, snapshot, ()=>processReply(event)))
    } else {
      storeMessageInitial(event, snapshot, ()=>processReply(event))
      
    }
  })

}

// Store the initial stage and condition for tracking purposes
function storeMessageInitial(event,snapshot, callback) {
  const sanitizedMessageID=event.message.mid.replace(/\.|#|\$|\[|\]/g,"")  
  const userRef = database.ref(`message/${event.sender.id}/${sanitizedMessageID}`)
  userRef.update({
    time:admin.database.ServerValue.TIMESTAMP,
    message: event.message.text,
    intial:{stage:snapshot.child("/stage").val(), condition:snapshot.child("/condition").val()}
  }, callback())
}

// Store the final stage and condition for tracking purposes
function storeMessageFinal(event, final) {
  const sanitizedMessageID=event.message.mid.replace(/\.|#|\$|\[|\]/g,"")  
  const userRef = database.ref(`message/${event.sender.id}/${sanitizedMessageID}/final`)
  userRef.set({
    stage: final.stage,
    condition: final.condition
  })
}

// When message for first time, store user information to greet them
function storeUserData(event, callback) {
  request(`https://graph.facebook.com/v2.6/${event.sender.id}?fields=first_name,last_name,profile_pic,locale,timezone,gender&access_token=${process.env.PAGE_ACCESS_TOKEN}`, (error, response, body) => {
    if(!error){
      const bodyJSON = JSON.parse(body)
      const userRef = database.ref(`user/${event.sender.id}`)
      userRef.set({
        stage:0,
        awaiting: false,
        userDetails: {
          firstName: bodyJSON.first_name,
          lastName: bodyJSON.last_name,
          profilePic: bodyJSON.profile_pic,
          locale: bodyJSON.locale,
          timezone: bodyJSON.timezone,
          gender: bodyJSON.gender
        }
      }, () => callback() )
    }
  }) 
}

// Main function that process the reply. Think of it as the controller.
// It's based on the current state and condition and is in charge of editing DB data.
function processReply(event) {
  const senderID = event.sender.id
  const userRef = database.ref(`user/${senderID}`)
  userRef.once("value", snapshot => {
    const awaiting = snapshot.child("awaiting").val()
    const lastReceivedTime = new Date(snapshot.child("lastReceivedTime").val())
    const timeNow = new Date()
    const message = event.message.text

    const stage = snapshot.child("stage").val()
    const minutesStored = snapshot.child("answers/minutes").val()
    const firstNameStored=snapshot.child("userDetails/firstName").val()
    let condition = snapshot.child("condition").val()
    let reply
    let finalStage,finalCondition 
    console.log("time since last message: "+Math.round((( (timeNow-lastReceivedTime) % 86400000) % 3600000) / 60000))
    
    // The keyword restart is introduced here to start from scratch. Same behaviour when last message is old.
    // It will present an informational message before starting all over again.
    if(message.toLowerCase()=="restart" || (Math.round((( (timeNow-lastReceivedTime) % 86400000) % 3600000) / 60000)>10 && stage != 0)){
        return userRef.update({stage:1, condition:3, lastReceivedTime: admin.database.ServerValue.TIMESTAMP, awaiting:false}, err => {
          if(err)
            new Error("Firebase connection error in processReply()")
          else {
            // This function is in charge of sending the message back.
            // Stage 3 is special for this case of restarting.
            selectReply(1, 3, senderID, {userName:snapshot.child("userDetails/firstName").val()})
            // This one stores the final stage for tracking.
            storeMessageFinal(event,{stage:1, condition:3})
          }
        })
    } else {
      switch(stage){
        case(0):
          userRef.update({stage:1, condition:1, lastReceivedTime: admin.database.ServerValue.TIMESTAMP, awaiting:false}, err =>{
            if(err)
              return new Error("Firebase connection error in processReply()")
            else{
              selectReply(1, 1, senderID, {userName:firstNameStored})
              storeMessageFinal(event,{stage:1, condition:1})
            }
          })
          break
        case(1):
          reply = validator(1, message)
          if(reply != false) {
            userRef.update({stage:2, condition:1, answers:{minutes:reply}, lastReceivedTime: admin.database.ServerValue.TIMESTAMP}, err =>{
              if(err)
                return new Error("Firebase connection error in processReply()")
              else {
                //
                selectReply(2, 1, senderID, {minutes: reply}) 
                storeMessageFinal(event,{stage:2, condition:1})
              }

            })
          } else {
            userRef.update({stage:1, condition:2, lastReceivedTime: admin.database.ServerValue.TIMESTAMP}, err =>{
              if (!err) {
                // Stage 2 is for unvalidated messages
                selectReply(1, 2, senderID)
                storeMessageFinal(event,{stage:1, condition:2})
              }

            })
          }
          break
        case(2):
          reply = validator(2, message)
            if(reply === "yes") {
              userRef.update({stage:3, condition:1, lastReceivedTime: admin.database.ServerValue.TIMESTAMP}, err =>{
                if(err)
                  return new Error("Firebase connection error in processReply()")
                else {
                  selectReply(3, 1, senderID) 
                  storeMessageFinal(event,{stage:3, condition:1})
                }

              })
            } else if(reply==="no"){
              userRef.update({stage:1, condition:4, lastReceivedTime: admin.database.ServerValue.TIMESTAMP}, err =>{
                if(err)
                  return new Error("Firebase connection error in processReply()")
                else {
                  selectReply(1, 4, senderID) 
                  storeMessageFinal(event,{stage:1, condition:4})
                }

              })
            } else {
              userRef.update({stage:2, condition:2, lastReceivedTime: admin.database.ServerValue.TIMESTAMP}, err =>{
                if (!err){
                  selectReply(2, 2, senderID)
                  storeMessageFinal(event,{stage:2, condition:2})
                }

              })
            }   
          break
        case 3:
          reply = validator(3, message)
          if (reply===false){
            userRef.update({stage:3, condition:2, lastReceivedTime: admin.database.ServerValue.TIMESTAMP}, err =>{
              if (!err){
                selectReply(3, 2, senderID)
                storeMessageFinal(event,{stage:3, condition:2})
              }

            })
          } else {
            userRef.update({stage:4, condition:1, answers:{minutes:minutesStored, interests:{business:reply.business, coding:reply.coding, design:reply.design}},lastReceivedTime: admin.database.ServerValue.TIMESTAMP}, err => {
              if (!err){
                // This generates the ordered array and then will use it to send the reply.
                orderedArray({business:reply.business, code:reply.coding, design:reply.design}, orderedBucket => {

                  const numberOfElements=initialNumberOfElements(minutesStored)
                  selectReply(4, 1, senderID, {name:firstNameStored, orderedBucket, numberOfElements})
                  storeMessageFinal(event,{stage:4, condition:1})
                })
              }  
            })
          }
          break
        case 4:
        case 5:
        default:
          userRef.update({stage:5, condition:1, lastReceivedTime: admin.database.ServerValue.TIMESTAMP}, err => {
            if (!err){
              selectReply(5, 1, senderID)
              storeMessageFinal(event,{stage:5, condition:1})
            }
          })  
        break
      } 
    }
  })
}

// Function used to validate messages.
function validator(stage, message){
  let clarifiedReply
  message = message.toLowerCase()
  switch(stage){
    case 1:
      clarifiedReply=parseInt(message.match(/\d+/))
      
      if(clarifiedReply>=1 && clarifiedReply<=120)
        return clarifiedReply
      else
        return false
      break
      
    case 2:
      if(/yes|y|yup|yeah|corr/.test(message))
        return "yes"
      else if(/nope|n|no|nah/.test(message))
        return "no"
      else
        return false
      break
      
    case 3:
      let interests = {business:false, coding:false, design:false}
      if(/bus/.test(message) || /ness/.test(message))
        interests.business=true
      if(/cod/.test(message))
        interests.coding=true
      if(/des/.test(message))
        interests.design=true
      if(interests.business===false && interests.coding===false && interests.design===false)
        return false
      else
        return interests
      break
  }
}

// This is somehow the view of the bot.
function selectReply(stage, condition, recipientId, props) {
  const userRef = database.ref(`user/${recipientId}`)  
  
  switch(stage) {
    case 1:
      if(condition===1 || condition===3){
        let delayIfConditionThree = 0
        if(condition===3) {
          delayIfConditionThree=3000
          sendTextMessage(recipientId, "It's been a while since last time so I'll start from scratch! <3", ()=>sendSenderAction(recipientId, "typing_on"))
        }
        
        setTimeout(()=>sendTextMessage(recipientId, `Howdy ${props.userName}! I’m Marco :)`, ()=> sendSenderAction(recipientId, "typing_on")),0+delayIfConditionThree)
        setTimeout(()=>sendTextMessage(recipientId, "Botting Marco.", ()=>sendSenderAction(recipientId, "typing_on")),1000+delayIfConditionThree)
        setTimeout(()=>sendTextMessage(recipientId, "Let me show you some of my recent work. This is the first portfolio bot ever. (afaik) :p", ()=>sendSenderAction(recipientId, "typing_on")),5000+delayIfConditionThree)
        setTimeout(()=>sendTextMessage(recipientId, "How many minutes do you have?", ()=>sendSenderAction(recipientId, "typing_off")),7000+delayIfConditionThree)
          
        userRef.update({awaiting: true})
        
      } else if (condition===2){
          sendTextMessage(recipientId, "Ok I’m not very smart I must admit. Can you please tell me how many minutes you have (somewhere between 1 and 120).", ()=>sendSenderAction(recipientId, "typing_off"))
      } else if (condition===4)
          sendTextMessage(recipientId, "So how many minutes do you have?", ()=>sendSenderAction(recipientId, "typing_off"))
      break 
    
    case 2:
      if(condition===1){
        sendTextMessage(recipientId, `I understand you have ${props.minutes} minutes. Is this correct?`, ()=>sendSenderAction(recipientId, "typing_off"))
      } else if(condition===2) {
        sendTextMessage(recipientId, `Just say yes, no, y, n, yeah, nah, noo, yup, nope. That’s all I can understand.`, ()=>sendSenderAction(recipientId, "typing_off"))
      }
    break
    
    case 3:
      if(condition===1){
        sendTextMessage(recipientId, `Awesome! What are you interested in?`, ()=>sendSenderAction(recipientId, "typing_on"))
        // For this we send some buttons to make the interaction easier.
        setTimeout(()=>sendOptions(recipientId, ()=>sendSenderAction(recipientId, "typing_off")), 1500)
      } else if(condition===2) {
        sendTextMessage(recipientId, `Yeah, I'm just a dummy bot and didn't get this one. To make my life easier say business, coding or design or more than one in one message and I'll figure it out`, ()=>sendSenderAction(recipientId, "typing_off"))
      }
      break
    case 4:
      if(condition===1){
        if(props.numberOfElements===0){
          sendTextMessage(recipientId, `Looks like someone is in a hurry! That's fine. Check these out:`, ()=>sendSenderAction(recipientId, "typing_on"))
          let contacts = [
            {
              url: "https://www.linkedin.com/in/marcogreselin/",
              title: "LinkedIn",
              image: "https://firebasestorage.googleapis.com/v0/b/botty-marco.appspot.com/o/chat_linkedin.png?alt=media&token=5cebeb74-ace4-4d10-9f01-534be8fdfb5b",
              subtitle: "LinkedIn has all my professional experience in a nutshell."
            },
            {
              url: "https://www.github.com/marcogreselin",
              title: "Github",
              image: "https://firebasestorage.googleapis.com/v0/b/botty-marco.appspot.com/o/chat_gh.png?alt=media&token=bc6a1aa3-5484-429f-bcab-eb7abb5a6594",
              subtitle: "In so little time GitHub will only prove that I can use Git (I know...) and that this cheeky website was manually crafted."
            },
            {
              url: "https://www.instagram.com/marcogreselin",
              title: "Instagram",
              image: "https://firebasestorage.googleapis.com/v0/b/botty-marco.appspot.com/o/chat_ig.png?alt=media&token=7eadca94-3b55-4e2d-80aa-f79ad0cb13ca",
              subtitle: "Instagram should give you a sense of my personality."
            }
          ]
          for(let i=0; i< contacts.length; i++)
            setTimeout(()=>sendGeneric(recipientId, {url:contacts[i].url, title: contacts[i].title, image: contacts[i].image, subtitle: contacts[i].subtitle}, ()=>sendSenderAction(recipientId, "typing_on")), 1000 + i*1000)
          setTimeout(()=>sendTextMessage(recipientId, `Now, if you still have questions, just drop me an email :) marcogreselin@me.com`, ()=>sendSenderAction(recipientId, "typing_off")), 12000)
        }
        else {
          sendTextMessage(recipientId, `Fantastic ${props.name}. Let me think for a sec.`, ()=>sendSenderAction(recipientId, "typing_on"))
          setTimeout(()=>sendTextMessage(recipientId, `Have a look at these ${props.numberOfElements} projects. Hope you find them interesting.`, ()=>sendSenderAction(recipientId, "typing_on")), 1500)
            for(let i=0; i<props.numberOfElements;i++) 
              // We send the generic template to make a better UI.
              setTimeout(()=>sendGeneric(recipientId, {url:`https://marcogreselin.com/work/${props.orderedBucket[i].name}`, title: props.orderedBucket[i].title, image: props.orderedBucket[i].portfolio_image, subtitle: props.orderedBucket[i].subtitle}, ()=>sendSenderAction(recipientId, "typing_off")), 3500+i*700)
          setTimeout(()=>sendTextMessage(recipientId, `Oh and obviously let me know if I can help. All my contacts are here :)`, ()=>sendSenderAction(recipientId, "typing_on")), 30000)
          setTimeout(()=>sendTextMessage(recipientId, `https://marcogreselin.com/me`, ()=>sendSenderAction(recipientId, "typing_off")), 35000)
        }
      } 
      break
    case 5: 
      sendTextMessage(recipientId, `My purpose in life is limited. Say 'restart' if you want to start over again or just wait some 10 minutes and I will be back to 0.`, ()=>sendSenderAction(recipientId, "typing_off"))
  }
}

// Count of elements based on minutes selected.
function initialNumberOfElements(minutes) {
    if(minutes<5)
        return 0
    else if(minutes<=10)
        return 3
    else 
        return Math.min(4+parseInt((minutes-10)/4,10), products.length)
}

// Array ordering logic based on interests.
function orderedArray(props, callback) {
    let sortedArray = products
    console.log(props.design)
    if(props.design && props.code && props.business)
        sortedArray.sort((a,b)=> (b.scores.quality*b.scores.relevancy.code*b.scores.relevancy.design*b.scores.relevancy.business-a.scores.quality*a.scores.relevancy.code*a.scores.relevancy.design*a.scores.relevancy.business))
    else if(props.design && props.code)
        sortedArray.sort((a,b) => (b.scores.quality*b.scores.relevancy.code*b.scores.relevancy.design/2)-(a.scores.quality*a.scores.relevancy.code*a.scores.relevancy.design/2))
    else if(props.design && props.business)
        sortedArray.sort((a,b) => (b.scores.quality*b.scores.relevancy.business*b.scores.relevancy.design/2)-(a.scores.quality*a.scores.relevancy.business*a.scores.relevancy.design/2))
    else if(props.business && props.code)
        sortedArray.sort((a,b) => (b.scores.quality*b.scores.relevancy.business*b.scores.relevancy.code/2)-(a.scores.quality*a.scores.relevancy.business*a.scores.relevancy.code/2))
    else if(props.business)
        sortedArray.sort((a,b)=> (b.scores.quality*b.scores.relevancy.business-a.scores.quality*a.scores.relevancy.business))
    else if(props.code)
        sortedArray.sort((a,b)=> (b.scores.quality*b.scores.relevancy.code-a.scores.quality*a.scores.relevancy.code))
    else if(props.design)
        sortedArray.sort((a,b)=> (b.scores.quality*b.scores.relevancy.design-a.scores.quality*a.scores.relevancy.design)) 
    return callback(sortedArray)
}


//////////////////////////
// Sending helpers
//////////////////////////

// This is for the portfolio projects.
function sendGeneric(recipientId, message, callback) {
  const messageData = {
    "recipient":{
      "id": recipientId
    },
    "message":{
      "attachment":{
        "type":"template",
        "payload":{
          "template_type":"generic",
          "elements":[
             {
              "title":message.title.substring(0, 70),
              "image_url":message.image,
              "subtitle":message.subtitle.substring(0, 70),
              "default_action": {
                "type": "web_url",
                "url": message.url,
                "messenger_extensions": true,
                "webview_height_ratio": "tall",
                "fallback_url": message.url
              }
            }
          ]
        }
      }
    }
  }

  callSendAPI(messageData, callback)
}

// This is for the interests selection.
function sendOptions(recipientId, callback) {
  const messageData = 
  {
    "recipient":{
      "id":recipientId
    },
    "message":{
      "text":"Choose between coding, business or design – or a combination if you want :)",
      "quick_replies":[
        {
          "content_type":"text",
          "title":"Business",
          "payload":"BUSINESS"
        },
        {
          "content_type":"text",
          "title":"Coding",
          "payload":"CODING"
        },
        {
          "content_type":"text",
          "title":"Design",
          "payload":"DESIGN"
        }
      ]
    }
  }
  callSendAPI(messageData, callback)
}

function sendTextMessage(recipientId, messageText, callback) {
  const messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      text: messageText
    }
  }

  callSendAPI(messageData, callback)
}

// This is for the typing effect.
function sendSenderAction(recipientId, action) {
  const messageData = {
    recipient: {
      id: recipientId
    },
    sender_action: action
  }
  
  callSendAPI(messageData)
}

function callSendAPI(messageData, callback) {
  request({
    uri: 'https://graph.facebook.com/v2.6/me/messages',
    qs: { access_token: process.env.PAGE_ACCESS_TOKEN },
    method: 'POST',
    json: messageData
  }, (error, response, body) => {
    if (!error && response.statusCode == 200) {
      const recipientId = body.recipient_id
      const messageId = body.message_id

      if(callback)
        callback()
      console.log("Successfully sent generic message with id %s to recipient %s", 
        messageId, recipientId)
    } else {
      console.error("Unable to send message.")
      console.error(response)
      console.error(error)
    }
  })
}

// Set Express to listen out for HTTP requests
const server = app.listen(process.env.PORT || 3000, function () {
  console.log("Listening on port %s", server.address().port)
})
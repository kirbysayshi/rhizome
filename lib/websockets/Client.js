/*
 * Copyright 2014, Sébastien Piquemal <sebpiq@gmail.com>
 *
 * rhizome is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * rhizome is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 * 
 * You should have received a copy of the GNU General Public License
 * along with rhizome.  If not, see <http://www.gnu.org/licenses/>.
 */

var EventEmitter = require('events').EventEmitter
  , querystring = require('querystring')
  , Buffer = require('buffer').Buffer
  , _ = require('underscore')
  , WebSocket = require('ws') // polyfilling not required -> https://github.com/einaros/ws/blob/master/lib/browser.js
  , expect = require('chai').expect
  , oscMin = require('osc-min')
  , cookie = require('./browser-deps/cookie').cookie
  , coreMessages = require('../core/messages')
  , coreValidation = require('../core/validation')
  , isBrowser = typeof window !== 'undefined'


// Maps socket state to client status
if (WebSocket) {
  var wsStates = _.object([
    [WebSocket.CONNECTING, 'stopped'],
    [WebSocket.OPEN, 'started'],
    [WebSocket.CLOSING, 'stopped'],
    [WebSocket.CLOSED, 'stopped']
  ])
}

var Client = module.exports = function(config) {
  EventEmitter.apply(this)
  this._socket = null
  this._socketEmitter = null    // socket-level event emitter
  this._rhizomeEmitter = null   // Rhizome-level event emitter
  this.id = null                // Unique id of the client
  this._config = config         // Set config defaults
  this._isBrowser = isBrowser   // little to trick to allow testing some features

  // Binding event handlers to allow `removeListener`
  this._onConnectionLost = _.bind(this._onConnectionLost, this)
}


_.extend(Client.prototype, EventEmitter.prototype, coreValidation.ValidateConfigMixin, {

  // ========================= PUBLIC API ========================= //

  // Starts the client, calling `done(err)` when the client is connected, or when it failed to start.
  start: function(done) {
    var self = this
    if (!this.isSupported()) {
      var err = new Error('the current browser is not supported')
      if (done) done(err)
      else throw err
    }

    if (this._socket) {
      this._socket.close()
      this._clean()
    }

    this._validateConfig(function(err) {
      if (err) return done(err)
      if (self._isBrowser)
        self.id = cookie.get(self._config.cookieName, null)
      self._rhizomeEmitter = new EventEmitter

      self._connect(function(err) {
        if (done) done(err)
        // We want to emit 'connected' after the `done` has been executed
        if (!err) self.emit('connected')
      })

    })
  },

  // Stops the client, calling `done(err)` when the connection was closed successfully.
  stop: function(done) {
    var self = this
    if (this._socket) {
      if (this._socket.readyState === this._socket.OPEN) {
        // If reconnection is armed, we need to cancel it immediately or it will be triggered
        // when the socket is done closing.
        this._socketEmitter.removeListener('close', this._onConnectionLost)
        this._socket.close()
        this._socketEmitter.once('close', function() {
          self._clean()
          if (done) done(null)
        })
      } else {
        this._clean()
        if (done) done(null)
      }
    } else if (done) done(null)
  },

  // Sends a message to OSC `address`, with arguments `args`, 
  send: function(address, args) {
    var self = this
    args = args || []
    if (_.isArray(args)) {
      args = _.map(args, function(arg) {
        if (arg instanceof ArrayBuffer)
          return new Buffer(new Uint8Array(arg))
        else return arg
      })
    }
    _assertValid(coreMessages.validateAddressForSend, address)
    _assertValid(coreMessages.validateArgs, args)
    this._socket.send(oscMin.toBuffer({ address: address, args: args }))
  },

  // Returns the current status of the client. Values can be `stopped` or `started`.
  status: function() {
    if (this._socket) {
      if (this.id === null) return 'stopped'
      else return wsStates[this._socket.readyState]
    } else return 'stopped'
  },

  // This function returns `true` if the web client is supported by the current browser, `false` otherwise.
  isSupported: function() { return _.isFunction(WebSocket) && WebSocket.prototype.CLOSING === 2 },

  // This function is used by the client to log events. By default it is a no-op.
  log: function() {},


  // ========================= PRIVATE API ========================= //
  _connect: function(done) {
    var self = this
      , query = {
        'queueIfFull': JSON.stringify(this._config.queueIfFull)
      }
    if (this.id) query.id = this.id
    if (this._isBrowser) {
      // `global` here is to allow testing
      query.os = (typeof window === 'undefined' ? global: window).navigator.oscpu
      query.browser = (typeof window === 'undefined' ? global: window).navigator.userAgent
    }

    // Create the socket and setup `_socketEmitter` to emit its events
    this._socket = new WebSocket('ws://' + this._config.hostname + ':' + this._config.port + '/'
      + '?' + querystring.stringify(query))
    this._socket.binaryType = 'arraybuffer'
    this._socketEmitter = new EventEmitter()
    this._socket.onerror = function(event) { self._socketEmitter.emit('error') }
    this._socket.onmessage = function(event) { self._socketEmitter.emit('message', event.data) }
    this._socket.onclose = function(event) { self._socketEmitter.emit('close') }
    this._socket.onopen = function(event) { self._socketEmitter.emit('open') }

    // Bind event handlers for socket events
    this._socketEmitter.on('message', _.bind(this._onSocketMessage, this))
    
    this._socketEmitter.once('open', function(event) {
      self._socketEmitter.removeAllListeners('error')
      self._socketEmitter.on('error', _.bind(self._onSocketError, self))
      self._rhizomeEmitter.once(coreMessages.connectionStatusAddress,
        _.bind(self._doRhizomeConnection, self, done))
    })

    this._socketEmitter.once('error', function(event) {
      self._socketEmitter.removeAllListeners('open')
      done(new Error('socket error'))
    })
  },

  _reconnect: function() {
    var self = this
    setTimeout(function() {
      self.log('socket reconnecting')
      self._connect(function(err) {
        if (err) {
          self.log('socket failed reconnecting ' + err.toString())
          self._reconnect()
        } else self.emit('connected')
      })

    }, this._config.reconnect)
  },

  _clean: function() {
    this.id = null
    this._socketEmitter.removeAllListeners()
    this._rhizomeEmitter = null
    this._socket = null
    this._socketEmitter = null
  },

  configValidator: new coreValidation.ChaiValidator({
    port: function(val) {
      expect(val).to.be.a('number')
      expect(val).to.be.within(0, 65535)
    },
    hostname: function(val) {
      expect(val).to.be.a('string')
    },
    reconnect: function(val) {
      expect(val).to.be.a('number')
    },
    queueIfFull: function(val) {
      expect(val).to.be.a('boolean')
    },
    cookieName: function(val) {
      expect(val).to.be.a('string')
    },
    useCookies: function(val) {
      expect(val).to.be.a('boolean')
    }
  }),

  configDefaults: {
    reconnect: 1000,
    queueIfFull: true,
    cookieName: 'rhizome',
    useCookies: true
  },

  // --------------- EVENT HANDLERS --------------- //
  _onConnectionLost: function(event) {
    this.emit('connection lost')
    this._rhizomeEmitter.removeAllListeners()
    if (this._config.reconnect) this._reconnect()
  },

  _doRhizomeConnection: function(done, args) {
    var status = args[0]

    // if `status` is 0, connection succeeded
    if (status === 0) {
      this.id = args[1]
      this._socketEmitter.once('close', this._onConnectionLost)
      if (this._isBrowser)
        cookie.set(this._config.cookieName, this.id)
      if (done) done()

    } else if (status === 1) {
      var error = args[1]
      
      // If the server is full and the client wants to queue, we wait for the server
      // to send a new 'connect' command.
      if (this._config.queueIfFull) {
        this.emit('queued')
        this._rhizomeEmitter.once(coreMessages.connectionStatusAddress,
          _.bind(this._doRhizomeConnection, this, done))

      // Otherwise, we don't queue, close the connection and return an error as the connection failed.
      } else {
        if (done)
          this._socketEmitter.once('close', done.bind(this, new Error(error)))
        this._socket.close()
      }
    }
  },

  _onSocketError: function(err) {
    // If there's no listener, we don't want an error to be thrown
    if (this.listeners('error').length)
      this.emit('error', err)
    this.log('socket error ', err.toString())
  },

  _onSocketMessage: function(data) {
    var msg = oscMin.fromBuffer(data)
      , address = msg.address
      , args = _.pluck(msg.args, 'value')
    if (address === coreMessages.connectionStatusAddress)
      this._rhizomeEmitter.emit(address, args)
    else this.emit('message', address, args)
  }

})

// --------------- MISC HELPERS --------------- //
var _assertValid = function(func, value) {
  var err = func(value)
  if (err !== null) throw new Error(err)
}

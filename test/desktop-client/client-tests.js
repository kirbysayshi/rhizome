var _ = require('underscore')
  , fs = require('fs')
  , async = require('async')
  , assert = require('assert')
  , shared = require('../../lib/shared')
  , oscServer = require('../../lib/server/osc')
  , wsServer = require('../../lib/server/websockets')
  , client = require('../../lib/desktop-client/client')
  , utils = require('../../lib/server/utils')
  , helpers = require('../helpers')

var serverConfig = {

  server: {
    blobsDirName: '/tmp',
    ip: '127.0.0.1',
    oscPort: 9000,
    webPort: 8000
  },

  clients: [ {ip: '127.0.0.1', port: 9001, desktopClientPort: 44444} ]

}

var clientConfig = {

  server: {
    ip: '127.0.0.1',
    oscPort: 9000
  },

  client: {
    port: 9001,
    desktopClientPort: 44444,
    blobsDirName: '/tmp'
  }

}

var sendToDesktopClient = new utils.OSCClient(serverConfig.clients[0].ip, serverConfig.clients[0].desktopClientPort)
  , fakePd = new utils.OSCServer(clientConfig.client.port)
  , sendToServer = new utils.OSCClient(clientConfig.server.ip, clientConfig.server.oscPort)


describe('desktop-client', function() {

  beforeEach(function(done) {
    fakePd.removeAllListeners()
    async.series([
      function(next) { oscServer.start(serverConfig, next) },
      function(next) { wsServer.start(serverConfig, next) }
    ], done)
  })

  afterEach(function(done) {
    helpers.afterEach(done)
  })

  describe('receive blob', function() {

    beforeEach(function(done) {
      client.start(clientConfig, done)
    })

    it('should save the blob and send a message to the final client (Pd, Processing...)', function(done) {
      var buf1 = new Buffer('blobby1')
        , buf2 = new Buffer('blobby2')
        , buf3 = new Buffer('blobby3')
        , received = []

      fakePd.on('message', function (address, args, rinfo) {
        received.push([address, args])
        if (received.length === 3) {

          // Open all the files, and replace the filePaths with the actual file content for test purpose.
          async.series(received.map(function(msg) {
            return function(next) { fs.readFile(msg[1][0], next) }
          }), function(err, results) {
            if (err) throw err

            received.forEach(function(msg, i) { msg[1][0] = results[i].toString() })
            helpers.assertSameElements(received, [
              ['/bla/blob', ['blobby1', 0]],
              ['/blo/bli/blob/', [ 'blobby2', 0]],
              ['/blob', [ 'blobby3', 1]]
            ])
            done()
          })
        }
      })

      sendToDesktopClient.send(shared.fromWebBlobAddress, ['/bla/blob', buf1, 0])
      sendToDesktopClient.send(shared.fromWebBlobAddress, ['/blo/bli/blob/', buf2, 0])
      sendToDesktopClient.send(shared.fromWebBlobAddress, ['/blob', buf3, 1])
    })

  })

  describe('send blob', function() {

    it('should send a blob to the server', function(done) {
      var received = []

      var receivedHandler = function(msg) {
        msg = JSON.parse(msg)
        received.push(msg)

        if (received.length === 4) {

          async.series(received.map(function(msg) {
            return function(next) { fs.readFile(msg.filePath, next) }
          }), function(err, results) {
            if (err) throw err
            
            received.forEach(function(r, i) {
              r.blob = results[i].toString()
              delete r.filePath
            })

            helpers.assertSameElements(received, [
              {command: 'blob', blob: 'blobbyA', address: '/bla/bli/blob'},
              {command: 'blob', blob: 'blobbyA', address: '/bla/bli/blob'},
              {command: 'blob', blob: 'blobbyB', address: '/blob/'},
              {command: 'blob', blob: 'blobbyC', address: '/BLO/blob/'}
            ])
            done()
          })
        }
      }

      // Dummy receivers
      wsServer.nsTree.get('/bla').data.sockets = [{ send: receivedHandler }]
      wsServer.nsTree.get('/').data.sockets = [{ send: receivedHandler }]

      async.series([
        function(next) { fs.writeFile('/tmp/blob1', 'blobbyA', next) },
        function(next) { fs.writeFile('/tmp/blob2', 'blobbyB', next) },
        function(next) { fs.writeFile('/tmp/blob3', 'blobbyC', next) },
      ], function(err) {
        if (err) throw err
        sendToServer.send('/bla/bli/blob', ['/tmp/blob1'])
        sendToServer.send('/blob/', ['/tmp/blob2'])
        sendToServer.send('/BLO/blob/', ['/tmp/blob3'])
      })
    })

    it('should refuse to send a blob that is not in the configured dirName', function(done) {
      oscServer.stop(function(err) {
        var fakeOscServer = new utils.OSCServer(serverConfig.server.oscPort)
        fakeOscServer.on('message', function(address, args) {
          assert.equal(address, shared.errorAddress)
          done()
        })
        sendToDesktopClient.send(shared.gimmeBlobAddress, ['/bla', '/home/spiq/secret_file'])
      })
    })

  })

})
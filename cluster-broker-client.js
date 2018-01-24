var url = require('url');
var scClient = require('socketcluster-client');
var EventEmitter = require('events').EventEmitter;

var trailingPortNumberRegex = /:[0-9]+$/;

// --------------------------
// ClusterBrokerClient
// --------------------------
/**
 * @param broker
 * @param options
 * @constructor
 */
var ClusterBrokerClient = function (broker, options) {
  EventEmitter.call(this);
  this.subMappers = []; // [{mapper: function, clients: url<->socket, targets: targetURIs}]
  this.pubMappers = [];
  this.broker = broker;
  this.targetClients = {}; // clientURI <-> remote socketcluster-client
  this.authKey = options.authKey || null;

  this._handleClientError = (err) => {
    this.emit('error', err);
  };
};

ClusterBrokerClient.prototype = Object.create(EventEmitter.prototype);

ClusterBrokerClient.prototype.errors = {
  NoMatchingTargetError: function (channelName) {
    var err = new Error(`Could not find a matching target server for the ${channelName} channel - The server may be down.`);
    err.name = 'NoMatchingTargetError';
    return err;
  }
};
/**
 * @param {string} uri ws://[::ffff:120.26.164.224]:8100
 * @return {{hostname: string | void | *, port}}
 */
ClusterBrokerClient.prototype.breakDownURI = function (uri) {
  var parsedURI = url.parse(uri);
  var hostname = parsedURI.host.replace(trailingPortNumberRegex, '');
  var result = {
    hostname: hostname,
    port: parsedURI.port
  };
  if (parsedURI.protocol === 'wss:' || parsedURI.protocol === 'https:') {
    result.secure = true;
  }
  return result;
};
/**
 * @param mapperList
 * @param mapper
 * @param {string[]} targetURIs scc-broker 服务器列表
 * @return {{mapper: *, clients: {}, targets: *}}
 * @private
 */
ClusterBrokerClient.prototype._mapperPush = function (mapperList, mapper, targetURIs) {
  var clientMap = {};

  targetURIs.forEach((clientURI) => {
    var clientConnectOptions = this.breakDownURI(clientURI);
    clientConnectOptions.query = {
      authKey: this.authKey
    };

    /**
     * 连接远程 state server
     * _mapperPush: { hostname: '[::ffff:127.0.0.1]',
     *   port: '8100',
     *   query: { authKey: null }
     * }
     */
    var client = scClient.connect(clientConnectOptions);
    client.removeListener('error', this._handleClientError);
    client.on('error', this._handleClientError);
    client.targetURI = clientURI;
    clientMap[clientURI] = client;
    this.targetClients[clientURI] = client;
  });

  var mapperContext = {
    mapper: mapper,
    clients: clientMap, // clientURI(string)<->socket
    targets: targetURIs
  };

  mapperList.push(mapperContext);

  return mapperContext;
};

ClusterBrokerClient.prototype._getAllBrokerSubscriptions = function () {
  var channelMap = {};
  var workerChannelMaps = Object.keys(this.broker.subscriptions);
  workerChannelMaps.forEach((index) => {
    var workerChannels = Object.keys(this.broker.subscriptions[index]);
    workerChannels.forEach((channelName) => {
      channelMap[channelName] = true;
    });
  });
  return Object.keys(channelMap);
};

ClusterBrokerClient.prototype.getAllSubscriptions = function () {
  var visitedClientsLookup = {}; // 已经遍历过的 clientURI
  var channelsLookup = {};       // channelName 不重复指定
  var subscriptions = [];        // 所有订阅的名称

  this.subMappers.forEach((mapperContext) => {
    Object.keys(mapperContext.clients).forEach((clientURI) => {
      var client = mapperContext.clients[clientURI];
      if (!visitedClientsLookup[clientURI]) {
        visitedClientsLookup[clientURI] = true;
        var subs = client.subscriptions(true); // socketcluster-client.subscriptions()
        subs.forEach((channelName) => {
          if (!channelsLookup[channelName]) {
            channelsLookup[channelName] = true;
            subscriptions.push(channelName);
          }
        });
      }
    });
  });

  var localBrokerSubscriptions = this._getAllBrokerSubscriptions();
  localBrokerSubscriptions.forEach((channelName) => {
    if (!channelsLookup[channelName]) {
      subscriptions.push(channelName);
    }
  });
  return subscriptions;
};

ClusterBrokerClient.prototype._cleanupUnusedTargetSockets = function () {
  var requiredClients = {};
  this.subMappers.forEach((subMapperContext) => {
    var subMapperTargetURIs = Object.keys(subMapperContext.clients);
    subMapperTargetURIs.forEach((uri) => {
      requiredClients[uri] = true;
    });
  });
  this.pubMappers.forEach((pubMapperContext) => {
    var pubMapperTargetURIs = Object.keys(pubMapperContext.clients);
    pubMapperTargetURIs.forEach((uri) => {
      requiredClients[uri] = true;
    });
  });
  var targetClientURIs = Object.keys(this.targetClients);
  targetClientURIs.forEach((targetURI) => {
    if (!requiredClients[targetURI]) {
      this.targetClients[targetURI].disconnect();
      delete this.targetClients[targetURI];
    }
  });
};
/**
 * @param mapper     一个把名字分配到 instance 的 hash 产生器
 * @param targetURIs broker 服务器列表
 */
ClusterBrokerClient.prototype.subMapperPush = function (mapper, targetURIs) {
  var mapperContext = this._mapperPush(this.subMappers, mapper, targetURIs);
  mapperContext.subscriptions = {};

  var activeChannels = this.getAllSubscriptions();

  activeChannels.forEach((channelName) => {
    this._subscribeWithMapperContext(mapperContext, channelName);
  });
};

ClusterBrokerClient.prototype.subMapperShift = function () {
  var activeChannels = this.getAllSubscriptions();
  var oldMapperContext = this.subMappers.shift();
  activeChannels.forEach((channelName) => {
    this._unsubscribeWithMapperContext(oldMapperContext, channelName);
  });
  this._cleanupUnusedTargetSockets();
};

ClusterBrokerClient.prototype.pubMapperPush = function (mapper, targetURIs) {
  this._mapperPush(this.pubMappers, mapper, targetURIs);
};

ClusterBrokerClient.prototype.pubMapperShift = function () {
  this.pubMappers.shift();
  this._cleanupUnusedTargetSockets();
};

ClusterBrokerClient.prototype._unsubscribeWithMapperContext = function (mapperContext, channelName) {
  var targetURI = mapperContext.mapper(channelName, mapperContext.targets);
  var targetClient = mapperContext.clients[targetURI];

  delete mapperContext.subscriptions[channelName];

  if (targetClient) {
    var isLastRemainingMappingForClientForCurrentChannel = true;

    // If any other subscription mappers map to this client for this channel,
    // then don't unsubscribe.
    var len = this.subMappers.length;

    for (var i = 0; i < len; i++) {
      var subMapperContext = this.subMappers[i];
      if (subMapperContext === mapperContext) {
        continue;
      }
      var subTargetURI = subMapperContext.mapper(channelName, subMapperContext.targets);
      if (targetURI === subTargetURI && subMapperContext.subscriptions[channelName]) {
        isLastRemainingMappingForClientForCurrentChannel = false;
        break;
      }
    }

    if (isLastRemainingMappingForClientForCurrentChannel) {
      targetClient.unsubscribe(channelName);
      targetClient.unwatch(channelName);
    }
  } else {
    var err = this.errors['NoMatchingTargetError'](channelName);
    this.emit('error', err);
  }
};

ClusterBrokerClient.prototype.unsubscribe = function (channelName) {
  this.subMappers.forEach((mapperContext) => {
    this._unsubscribeWithMapperContext(mapperContext, channelName);
  });
};

ClusterBrokerClient.prototype._handleChannelMessage = function (channelName, packet) {
  this.emit('message', channelName, packet);
};

ClusterBrokerClient.prototype._subscribeWithMapperContext = function (mapperContext, channelName) {
  var targetURI = mapperContext.mapper(channelName, mapperContext.targets);
  var targetClient = mapperContext.clients[targetURI];
  if (targetClient) {
    mapperContext.subscriptions[channelName] = targetClient.subscribe(channelName, {batch: true});
    if (!targetClient.watchers(channelName).length) {
      targetClient.watch(channelName, this._handleChannelMessage.bind(this, channelName));
    }
  } else {
    var err = this.errors['NoMatchingTargetError'](channelName);
    this.emit('error', err);
  }
};

ClusterBrokerClient.prototype.subscribe = function (channelName) {
  this.subMappers.forEach((mapperContext) => {
    this._subscribeWithMapperContext(mapperContext, channelName);
  });
};

ClusterBrokerClient.prototype._publishWithMapperContext = function (mapperContext, channelName, data) {
  var targetURI = mapperContext.mapper(channelName, mapperContext.targets);
  var targetClient = mapperContext.clients[targetURI];
  if (targetClient) {
    targetClient.publish(channelName, data);
  } else {
    var err = this.errors['NoMatchingTargetError'](channelName);
    this.emit('error', err);
  }
};

ClusterBrokerClient.prototype.publish = function (channelName, data) {
  this.pubMappers.forEach((mapperContext) => {
    this._publishWithMapperContext(mapperContext, channelName, data);
  });
};

module.exports.ClusterBrokerClient = ClusterBrokerClient;

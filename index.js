var scClient = require('socketcluster-client');
var ClusterBrokerClient = require('./cluster-broker-client').ClusterBrokerClient;
var uuid = require('uuid');

var DEFAULT_PORT = 7777;
var DEFAULT_MESSAGE_CACHE_DURATION = 10000;
var DEFAULT_RETRY_DELAY = 2000;
var DEFAULT_STATE_SERVER_CONNECT_TIMEOUT = 3000;
var DEFAULT_STATE_SERVER_ACK_TIMEOUT = 2000;

var DEFAULT_RECONNECT_RANDOMNESS = 1000;

/**
 * @param {*} broker
 * @param {*} options The options object needs to have a stateServerHost property.
 * @return {ClusterBrokerClient}
 */
module.exports.attach = function (broker, options) {
  var reconnectRandomness = options.stateServerReconnectRandomness || DEFAULT_RECONNECT_RANDOMNESS;
  var authKey = options.authKey || null;

  var clusterClient = new ClusterBrokerClient(broker, {authKey: authKey});
  if (!options.noErrorLogging) {
    clusterClient.on('error', function (err) {
      console.error(err);
    });
  }

  var latestSnapshotTime = -1;
  var latestServerInstancesSnapshot = '[]'; // 上次接受的 broker server 列表
  var serverInstances = []; // 所有远程 broker 服务器列表
  var processedMessagesLookup = {};
  var messageCacheDuration = options.brokerMessageCacheDuration || DEFAULT_MESSAGE_CACHE_DURATION;
  var retryDelay = options.brokerRetryDelay || DEFAULT_RETRY_DELAY;

  /**
   * server 端 broker 服务器列表发生变化通知客户端
   * @param updatePacket
   * @return {boolean}
   */
  var updateServerCluster = function (updatePacket) {
    // broker server urls { serverInstances: [ 'ws://[::ffff:127.0.0.1]:8100' ], time: 1516356554492 }
    var newServerInstancesSnapshot = JSON.stringify(updatePacket.serverInstances);
    if (updatePacket.time > latestSnapshotTime && newServerInstancesSnapshot !== latestServerInstancesSnapshot) {
      latestServerInstancesSnapshot = newServerInstancesSnapshot;
      serverInstances = updatePacket.serverInstances;
      latestSnapshotTime = updatePacket.time;
      return true;
    }
    return false;
  };

  // 连接 state server
  var scStateSocketOptions = {
    hostname: options.stateServerHost, // Required option
    port: options.stateServerPort || DEFAULT_PORT,
    connectTimeout: options.stateServerConnectTimeout || DEFAULT_STATE_SERVER_CONNECT_TIMEOUT,
    ackTimeout: options.stateServerAckTimeout || DEFAULT_STATE_SERVER_ACK_TIMEOUT,
    autoReconnectOptions: {
      initialDelay: retryDelay,
      randomness: reconnectRandomness,
      multiplier: 1,
      maxDelay: retryDelay + reconnectRandomness
    },
    query: {
      authKey: authKey
    }
  };

  // 连接到 scc state server, 然后 server 返回 broker server url
  var stateSocket = scClient.connect(scStateSocketOptions);
  stateSocket.on('error', function (err) {
    clusterClient.emit('error', err);
  });

  /**
   * 用 broker 初始化描述对象
   * @type {{instanceId: *, instanceIp:*, instanceIpFamily:*}}
   */
  var stateSocketData = {
    instanceId: broker.instanceId
  };

  if (broker.options.clusterInstanceIp != null) {
    stateSocketData.instanceIp = broker.options.clusterInstanceIp;
  }
  if (broker.options.clusterInstanceIpFamily != null) {
    stateSocketData.instanceIpFamily = broker.options.clusterInstanceIpFamily;
  }

  var serverMapper = function (channelName, serverInstanceList) {
    var ch;
    var hash = channelName;

    for (var i = 0; i < channelName.length; i++) {
      ch = channelName.charCodeAt(i);
      hash = ((hash << 5) - hash) + ch;
      hash = hash & hash;
    }
    var targetIndex = Math.abs(hash) % serverInstanceList.length;
    return serverInstanceList[targetIndex];
  };

  var sendClientStateTimeout = -1;

  var sendClientState = function (stateName) {
    clearTimeout(sendClientStateTimeout);
    stateSocket.emit('clientSetState', {
      instanceState: stateName + ':' + JSON.stringify(serverInstances)
    }, (err) => {
      if (err) {
        sendClientStateTimeout = setTimeout(sendClientState.bind(this, stateName), retryDelay);
      }
    });
  };

  /**
   * scc-broker 上线或者离线
   * @param data
   * @param respond
   */
  var addNewSubMapping = function (data, respond) {
    var updated = updateServerCluster(data);
    if (updated) {
      clusterClient.subMapperPush(serverMapper, serverInstances);
      sendClientState('updatedSubs');
    }
    respond();
  };

  var resetState = function () {
    while (clusterClient.pubMappers.length > 0) {
      clusterClient.pubMapperShift();
    }
    while (clusterClient.subMappers.length > 0) {
      clusterClient.subMapperShift();
    }
    latestSnapshotTime = -1;
    latestServerInstancesSnapshot = '[]';
    serverInstances = [];
    processedMessagesLookup = {};
  };

  var completeMappingUpdates = function () {
    // This means that all clients have converged on the 'ready' state
    // When this happens, we can remove all mappings except for the latest one.
    while (clusterClient.pubMappers.length > 1) {
      clusterClient.pubMapperShift();
    }
    while (clusterClient.subMappers.length > 1) {
      clusterClient.subMapperShift();
    }
    sendClientState('active');
  };

  stateSocket.on('serverJoinCluster', addNewSubMapping);
  stateSocket.on('serverLeaveCluster', addNewSubMapping);

  /**
   * 远程 client set state 时候触发
   */
  stateSocket.on('clientStatesConverge', function (data, respond) {
    if (data.state === 'updatedSubs:' + JSON.stringify(serverInstances)) {
      clusterClient.pubMapperPush(serverMapper, serverInstances);
      while (clusterClient.pubMappers.length > 1) {
        clusterClient.pubMapperShift();
      }
      sendClientState('updatedPubs');
    } else if (data.state === 'updatedPubs:' + JSON.stringify(serverInstances)) {
      completeMappingUpdates();
    }
    respond();
  });

  var emitClientJoinCluster = function () {
    stateSocket.emit('clientJoinCluster', stateSocketData, function (err, data) {
      if (err) {
        setTimeout(emitClientJoinCluster, retryDelay);
        return;
      }
      resetState();
      updateServerCluster(data);
      clusterClient.subMapperPush(serverMapper, serverInstances);
      clusterClient.pubMapperPush(serverMapper, serverInstances);
      sendClientState('active');
    });
  };
  stateSocket.on('connect', emitClientJoinCluster);

  var removeMessageFromCache = function (messageId) {
    delete processedMessagesLookup[messageId];
  };

  var clusterMessageHandler = function (channelName, packet) {
    if ((packet.sender == null || packet.sender !== broker.instanceId) && packet.messages && packet.messages.length) {
      if (processedMessagesLookup[packet.id] == null) {
        packet.messages.forEach(function (data) {
          broker.publish(channelName, data);
        });
      } else {
        clearTimeout(processedMessagesLookup[packet.id]);
      }
      processedMessagesLookup[packet.id] = setTimeout(removeMessageFromCache.bind(null, packet.id), messageCacheDuration);
    }
  };
  clusterClient.on('message', clusterMessageHandler);

  broker.on('subscribe', function (channelName) {
    clusterClient.subscribe(channelName);
  });
  broker.on('unsubscribe', function (channelName) {
    clusterClient.unsubscribe(channelName);
  });

  var publishOutboundBuffer = {};
  var publishTimeout = null;

  var flushPublishOutboundBuffer = function () {
    Object.keys(publishOutboundBuffer).forEach(function (channelName) {
      var packet = {
        sender: broker.instanceId || null,
        messages: publishOutboundBuffer[channelName],
        id: uuid.v4()
      };
      clusterClient.publish(channelName, packet);
    });

    publishOutboundBuffer = {};
    publishTimeout = null;
  };

  /**
   * publish 消息, 发送到远程
   */
  broker.on('publish', function (channelName, data) {
    if (broker.options.pubSubBatchDuration == null) {
      var packet = {
        sender: broker.instanceId || null,
        messages: [data],
        id: uuid.v4()
      };
      clusterClient.publish(channelName, packet);

    } else {
      if (!publishOutboundBuffer[channelName]) {
        publishOutboundBuffer[channelName] = [];
      }
      publishOutboundBuffer[channelName].push(data);

      if (!publishTimeout) {
        publishTimeout = setTimeout(flushPublishOutboundBuffer, broker.options.pubSubBatchDuration);
      }
    }
  });

  return clusterClient;
};

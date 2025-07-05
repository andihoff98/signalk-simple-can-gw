const can = require("socketcan");

module.exports = (app) => {
  let channel;
  let subList = [];
  const plugin = {
    id: 'simple-can-gw',
    name: 'Simple CAN Gateway',
    start: (options, restartPlugin) => {
      app.debug("Starting simple CAN plugin");

      // Create mappings
      const inputs = (options.inputs || []).map(entry => ({
        id: parseInt(entry.id, 16),
        rt: entry.realtime,
        type: entry.type,
        path: entry.path,
        lastSend: 0
      }));

      const outputs = (options.outputs || []).map(entry => ({
        id: parseInt(entry.id, 16),
        rt: entry.realtime,
        type: entry.type,
        path: entry.path
      }));

      channel = can.createRawChannel(options.canInterface, true);
      
      // Mask states which bits should be set e.g. 0x400 will only match frames with MSB set
      app.debug(`Setting up CAN channel ${options.canInterface} with filter ID ${options.filterID} and mask ${options.filterMask}`);
      channel.setRxFilters({id: parseInt(options.filterID, 16), mask: parseInt(options.filterMask, 16)});

      // Listener for incoming frames
      channel.addListener("onMessage", function(frame) {
        //app.debug(`Received CAN frame 0x${frame.id.toString(16)} with data: ${frame.data.toString('hex')}`);
        const mapping = inputs.find(input => input.id === frame.id);
        // Not configured to decode this ID
        if (!mapping) { return; }

        // Check if we already sent this frame recently
        const now = Date.now();
        if (now - mapping.lastSend < options.throttle) {
          app.debug(`Ignoring CAN frame 0x${frame.id.toString(16)} due to throttle`);
          return;
        }
        mapping.lastSend = now;

        let value;
        try {
          if (mapping.type === "uint") {
            value = frame.data.readUInt32LE(0);
          } else if (mapping.type === "int") {
            value = frame.data.readInt32LE(0);
          } else if (mapping.type === "float") {
            value = frame.data.readFloatLE(0);
          }
          else if (mapping.type === "xyz-float") {
            value = {
              x: frame.data.readFloatLE(0),
              y: frame.data.readFloatLE(4),
              z: frame.data.readFloatLE(8)
            };
          }
        } catch (err) {
          app.error(`Error decoding frame 0x${frame.id.toString(16)}: ${err.message}`);
          return;
        }

        app.debug(`Decoded CAN 0x${frame.id.toString(16)} = ${value} (${mapping.type}) to ${mapping.path}`);

        app.handleMessage("simple-can-gw", {
          updates: [
            {
              values: [
                {
                  path: mapping.path,
                  value: value
                }
              ]
            }
          ]
        });
      });
      
      outputs.forEach(output => {
        let handler = (value) => {
          if (typeof value === "object" && value !== null && "value" in value) {
            value = value.value;
          }
          app.debug(`Encoding ${value} (${output.type}) to CAN ID 0x${output.id.toString(16)}`);
          
          const buffer = Buffer.alloc(8); // All zeros, can adjust size if needed
          try {
            if (output.type === "uint") {
              buffer.writeUInt32LE(value, 0);
            } else if (output.type === "int") {
              buffer.writeInt32LE(value, 0);
            } else if (output.type === "float") {
              buffer.writeFloatLE(value, 0);
            }
          } catch (err) {
            app.error(`Error encoding ${output.path}: ${err.message}`);
            return;
          }
          
          const frame = { id: output.id, data: buffer };
          channel.send(frame);
        }
        if (output.rt) {
          const sub = app.streambundle.getBus(output.path).onValue(handler);
        } else {
          const sub = app.streambundle.getBus(output.path).throttle(options.throttle).onValue(handler);
        }
        subList.push(sub);
      });

      channel.start();
    },
    stop: () => {
      if (channel) {
        app.debug("Stopping CAN channel");
        channel.stop();
        channel = null;
      }
      if (subList) {
        subList.forEach(u => u && u());
        subList = [];
      }
    },
    schema: () => ({
      title: "Simple CAN GW Configuration",
      description: "Configure CAN IDs to decode incoming data and encode outgoing deltas.",
      type: "object",
      properties: {
        canInterface: { type: "string", title: "CAN Interface", default: "can0" },
        throttle: { type: "number", title: "Throttle Time (ms)", default: 5000, minimum: 1000, maximum: 60000 },
        filterID: { type: "string", title: "CAN ID Filter", description: "Filter which CAN IDs to process", default: "0x400" },
        filterMask: { type: "string", title: "CAN ID Mask", description: "Mask off bits in CAN ID", default: "0x400" },
        inputs: {
          type: "array",
          title: "CAN ID Inputs",
          items: {
            type: "object",
            required: ["id", "type", "path", "realtime"],
            properties: {
              id: { type: "string", title: "CAN ID (e.g. 0x123)", default: "0x123" },
              realtime: { type: "boolean", title: "Realtime Updates", default: false },
              type: { type: "string", title: "Data Type", enum: ["uint", "int", "float", "xyz-float"], default: "float" },
              path: { type: "string", title: "Signal K Path to write to", default: "environment.depth.belowTransducer" }
            }
          },
          default: []
        },
        outputs: {
          type: "array",
          title: "CAN ID Outputs",
          items: {
            type: "object",
            required: ["id", "type", "path", "realtime"],
            properties: {
              id: { type: "string", title: "CAN ID (e.g. 0x400)", default: "0x400" },
              realtime: { type: "boolean", title: "Realtime Updates", default: false },
              type: { type: "string", title: "Data Type", enum: ["uint", "int", "float"], default: "float" },
              path: { type: "string", title: "Signal K Path to read from", default: "environment.depth.belowTransducer" }
            }
          },
          default: []
        }
      }
    })
  }
  return plugin
}

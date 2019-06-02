'use strict';

// Native
const EventEmitter = require('events');
const fs = require('fs');

// Packages
const HID = require('node-hid');
var jpg = require('@julusian/jpeg-turbo')

const NUM_KEYS = 32;
const HID_PACKET_SIZE = 1024;
const ICON_SIZE = 96;
const ICON_BYTES = ICON_SIZE * ICON_SIZE * 3;

const jpeg_options = {
	format: jpg.FORMAT_RGB,
	width: 96,
	height: 96,
	quality: 95,
	subsampling: jpg.SAMP_420
};

class StreamDeck extends EventEmitter {
	/**
	 * The pixel size of an icon written to the Stream Deck key.
	 *
	 * @readonly
	 */
	static get ICON_SIZE() {
		return ICON_SIZE;
	}

	/**
	 * Checks a value is a valid RGB value. A number between 0 and 255.
	 *
	 * @static
	 * @param {number} value The number to check
	 */
	static checkRGBValue(value) {
		if (value < 0 || value > 255) {
			throw new TypeError('Expected a valid color RGB value 0 - 255');
		}
	}

	/**
	 * Checks a keyIndex is a valid key for a stream deck xl. A number between 0 and 31.
	 *
	 * @static
	 * @param {number} keyIndex The keyIndex to check
	 */
	static checkValidKeyIndex(keyIndex) {
		if (keyIndex < 0 || keyIndex > NUM_KEYS) {
			throw new TypeError('Expected a valid keyIndex 0 - ' + (NUM_KEYS -1));
		}
	}

	/**
	 * Converts a buffer into an number[]. Used to supply the underlying
	 * node-hid device with the format it accepts.
	 *
	 * @static
	 * @param {Buffer} buffer Buffer to convert
	 * @returns {number[]} the converted buffer
	 */
	static bufferToIntArray(buffer) {
		const array = [];

		for (var i = 0; i < buffer.length; ++i) {
			array.push(buffer[i]);
		}

		return array;
	}

	constructor(devicePath) {
		super();

		if (typeof devicePath === 'undefined') {
			// Device path not provided, will then select any connected device.
			const devices = HID.devices();
			const connectedStreamDecks = devices.filter(device => {
				return device.vendorId === 0x0fd9 && device.productId === 0x006c;
			});
			if (!connectedStreamDecks.length) {
				throw new Error('No Stream Deck XLs are connected.');
			}
			this.device = new HID.HID(connectedStreamDecks[0].path);
		} else {
			this.device = new HID.HID(devicePath);
		}

		this.keyState = new Array(NUM_KEYS).fill(false);

		this.device.on('data', data => {
			// The first byte is a report ID, the last byte appears to be padding.
			// We strip these out for now.
			data = data.slice(4, data.length - 1);

			for (let i = 0; i < NUM_KEYS; i++) {
				const keyPressed = data[i] == 1;
				const stateChanged = keyPressed !== this.keyState[i];
				if (stateChanged) {
					this.keyState[i] = keyPressed;
					if (keyPressed) {
						this.emit('down', i);
					} else {
						this.emit('up', i);
					}
				}
			}
		});

		this.device.on('error', err => {
			this.emit('error', err);
		});
	}

	/**
	 * Writes a Buffer to the Stream Deck.
	 *
	 * @param {Buffer} buffer The buffer written to the Stream Deck
	 * @returns undefined
	 */
	write(buffer) {
		return this.device.write(StreamDeck.bufferToIntArray(buffer));
	}

	/**
	 * Sends a HID feature report to the Stream Deck.
	 *
	 * @param {Buffer} buffer The buffer send to the Stream Deck.
	 * @returns undefined
	 */
	sendFeatureReport(buffer) {
		return this.device.sendFeatureReport(StreamDeck.bufferToIntArray(buffer));
	}

	/**
	 * Fills the given key with a solid color.
	 *
	 * @param {number} keyIndex The key to fill 0 - 31
	 * @param {number} r The color's red value. 0 - 255
	 * @param {number} g The color's green value. 0 - 255
	 * @param {number} b The color's blue value. 0 -255
	 */
	fillColor(keyIndex, r, g, b) {
		StreamDeck.checkValidKeyIndex(keyIndex);

		StreamDeck.checkRGBValue(r);
		StreamDeck.checkRGBValue(g);
		StreamDeck.checkRGBValue(b);

		const pixel = Buffer.from([r, g, b]);
		var pixels = Buffer.alloc(ICON_BYTES, pixel);
		var outbuf = new Buffer(jpg.bufferSize(jpeg_options));
		var out = jpg.compressSync(pixels, outbuf, jpeg_options);

		var rest = out.length;
		let count = 0;
		let spos = 0;

		var buf = new Buffer(HID_PACKET_SIZE);

		while (rest > 0) {
			let packet_len = Math.min(rest, HID_PACKET_SIZE - 8);
			buf.writeUInt8(0x02, 0); // report id
			buf.writeUInt8(0x07, 1); // cmd
			buf.writeUInt8(keyIndex, 2);
			buf.writeUInt8(rest <= (HID_PACKET_SIZE - 8) ? 1 : 0, 3); // is done?
			buf.writeUInt16LE(packet_len, 4);
			buf.writeUInt16LE(count++, 6);
			out.copy(buf, 8, out.length - rest, (out.length - rest) + packet_len);
			rest -= packet_len;

			this.write(buf);
		}
	}


	/**
	 * Fills the given key with an image in a Buffer. 96x96
	 *
	 * @param {number} keyIndex The key to fill 0 - 31
	 * @param {Buffer} imageBuffer
	 */

	fillImage96(keyIndex, imageBuffer, ts) {
		StreamDeck.checkValidKeyIndex(keyIndex);

		if (imageBuffer.length !== 27360) {
			throw new RangeError(`Expected image buffer of length 27360, got length ${imageBuffer.length}`);
		}

		let pixels = new Buffer(ICON_BYTES);

		let pos = 0;
		let ipos = 27360 - 1;
		for (let y = 95; y >= 0; --y) {
			for (let x = 95; x >= 0; --x) {
				pixels[pos++] = imageBuffer[ipos-2];
				pixels[pos++] = imageBuffer[ipos-1];
				pixels[pos++] = imageBuffer[ipos];
				ipos -= 3;
			}
		}

		let outbuf = new Buffer(jpg.bufferSize(jpeg_options));
		let out = jpg.compressSync(pixels, outbuf, jpeg_options);

		var rest = out.length;
		let count = 0;
		let spos = 0;

		let buf = new Buffer(HID_PACKET_SIZE);

		while (rest > 0) {
			let packet_len = Math.min(rest, HID_PACKET_SIZE - 8);
			buf.writeUInt8(0x02, 0); // report id
			buf.writeUInt8(0x07, 1); // cmd
			buf.writeUInt8(keyIndex, 2);
			buf.writeUInt8(rest <= (HID_PACKET_SIZE - 8) ? 1 : 0, 3); // is done?
			buf.writeUInt16LE(packet_len, 4);
			buf.writeUInt16LE(count++, 6);
			out.copy(buf, 8, out.length - rest, (out.length - rest) + packet_len);
			rest -= packet_len;

			this.write(buf);
		}
	}

	/**
	 * Fills the given key with an image in a Buffer. Scales 72x72 to 96x96
	 *
	 * @param {number} keyIndex The key to fill 0 - 41
	 * @param {Buffer} imageBuffer
	 */

	fillImage(keyIndex, imageBuffer, ts) {
		StreamDeck.checkValidKeyIndex(keyIndex);

		if (imageBuffer.length === 27360) {
			return fillImage96(keyIndex, imageBuffer, ts);
		}

		if (imageBuffer.length !== 15552) {
			throw new RangeError(`Expected image buffer of length 15552, got length ${imageBuffer.length}`);
		}

		let pixels = new Buffer(ICON_BYTES);

		let div = 72/96;

		let pos = 0;
		for (let y = 95; y >= 0; --y) {
			for (let x = 95; x >= 0; --x) {
				let ipos = ((Math.round(x*div) + (Math.round(y*div)*72)) * 3);
				pixels[pos++] = imageBuffer[ipos];
				pixels[pos++] = imageBuffer[ipos+1];
				pixels[pos++] = imageBuffer[ipos+2];
			}
		}

		let outbuf = new Buffer(jpg.bufferSize(jpeg_options));
		let out = jpg.compressSync(pixels, outbuf, jpeg_options);

		let rest = out.length;
		let count = 0;
		let spos = 0;

		let buf = new Buffer(HID_PACKET_SIZE);

		while (rest > 0) {
			let packet_len = Math.min(rest, HID_PACKET_SIZE - 8);
			buf.writeUInt8(0x02, 0); // report id
			buf.writeUInt8(0x07, 1); // cmd
			buf.writeUInt8(keyIndex, 2);
			buf.writeUInt8(rest <= (HID_PACKET_SIZE - 8) ? 1 : 0, 3); // is done?
			buf.writeUInt16LE(packet_len, 4);
			buf.writeUInt16LE(count++, 6);
			out.copy(buf, 8, out.length - rest, (out.length - rest) + packet_len);
			rest -= packet_len;

			this.write(buf);
		}
	}

	/**
	 * Clears the given key.
	 *
	 * @param {number} keyIndex The key to clear 0 - 31
	 * @returns {undefined}
	 */
	clearKey(keyIndex) {
		StreamDeck.checkValidKeyIndex(keyIndex);
		return this.fillColor(keyIndex, 0, 0, 0);
	}

	/**
	 * Clears all keys.
	 *
	 * returns {undefined}
	 */
	clearAllKeys() {
		for (let keyIndex = 0; keyIndex < NUM_KEYS; keyIndex++) {
			this.clearKey(keyIndex);
		}
	}

	/**
	 * Sets the brightness of the keys on the Stream Deck
	 *
	 * @param {number} percentage The percentage brightness
	 */
	setBrightness(percentage) {
		if (percentage < 0 || percentage > 100) {
			throw new RangeError('Expected brightness percentage to be between 0 and 100');
		}

		var buf = new Buffer(32);
		buf.writeUInt8(3, 0);
		buf.writeUInt8(8, 1);
		buf.writeUInt8(percentage, 2);

		this.sendFeatureReport(buf);
	}

}

module.exports = StreamDeck;

"use strict";
/* exported tcpsocket */
/* global ExtensionAPI, ChromeUtils, Cu */

const { TCPSocket } = Cu.getGlobalForObject(
    ChromeUtils.import("resource://gre/modules/Services.jsm")
);

var tcp_socket;

/**
 * Concatenate two Uint8Array objects
 */
function concatUint8Arrays(a, b) {
    let newArr = new Uint8Array(a.length + b.length);
    newArr.set(a, 0);
    newArr.set(b, a.length);
    return newArr;
}

/**
 * Helper method to add event listeners to a socket and provide two Promise-returning
 * helpers (see below for docs on them).  This *must* be called during the turn of
 * the event loop where TCPSocket's constructor is called or the onconnect method is being
 * invoked.
 */
function listenForEventsOnSocket(socket, socketType) {
    let wantDataLength = null;
    let wantDataAndClose = false;
    let pendingResolve = null;
    let receivedEvents = [];
    let receivedData = null;
    let handleGenericEvent = function(event) {
        console.log(event);
        console.log("(" + socketType + " event: " + event.type + ")\n");
        if (pendingResolve && wantDataLength === null) {
            pendingResolve(event);
            pendingResolve = null;
        } else {
            receivedEvents.push(event);
        }
    };

    socket.onopen = handleGenericEvent;
    socket.ondrain = handleGenericEvent;
    socket.onerror = handleGenericEvent;
    socket.onclose = function(event) {
        if (!wantDataAndClose) {
            handleGenericEvent(event);
        } else if (pendingResolve) {
            console.log("(" + socketType + " event: close)\n");
            pendingResolve(receivedData);
            pendingResolve = null;
            wantDataAndClose = false;
        }
    };
    socket.ondata = function(event) {
        console.log(
            "(" +
            socketType +
            " event: " +
            event.type +
            " length: " +
            event.data.byteLength +
            ")\n"
        );

        var arr = new Uint8Array(event.data);
        if (receivedData === null) {
            receivedData = arr;
        } else {
            console.log(receivedData);
            receivedData = concatUint8Arrays(receivedData, arr);
        }
        if (wantDataLength !== null && receivedData.length >= wantDataLength) {
            pendingResolve(receivedData);
            pendingResolve = null;
            receivedData = null;
            wantDataLength = null;
        }
    };

    return {
        /**
         * Return a Promise that will be resolved with the next (non-data) event
         * received by the socket.  If there are queued events, the Promise will
         * be immediately resolved (but you won't see that until a future turn of
         * the event loop).
         */
        waitForEvent() {
            if (pendingResolve) {
                throw new Error("only one wait allowed at a time.");
            }

            if (receivedEvents.length) {
                return Promise.resolve(receivedEvents.shift());
            }

            console.log("(" + socketType + " waiting for event)\n");
            return new Promise(function(resolve, reject) {
                pendingResolve = resolve;
            });
        },
        /**
         * Return a Promise that will be resolved with a Uint8Array of at least the
         * given length.  We buffer / accumulate received data until we have enough
         * data.  Data is buffered even before you call this method, so be sure to
         * explicitly wait for any and all data sent by the other side.
         */
        waitForDataWithAtLeastLength(length) {
            if (pendingResolve) {
                throw new Error("only one wait allowed at a time.");
            }
            if (receivedData && receivedData.length >= length) {
                let promise = Promise.resolve(receivedData);
                receivedData = null;
                return promise;
            }
            console.log("(" + socketType + " waiting for " + length + " bytes)\n");
            return new Promise(function(resolve, reject) {
                pendingResolve = resolve;
                wantDataLength = length;
            });
        },
        waitForAnyDataAndClose() {
            if (pendingResolve) {
                throw new Error("only one wait allowed at a time.");
            }

            return new Promise(function(resolve, reject) {
                pendingResolve = resolve;
                // we may receive no data before getting close, in which case we want to
                // return an empty array
                receivedData = new Uint8Array();
                wantDataAndClose = true;
            });
        },
    };
}

function closeSocket() {
    if (!tcp_socket) {
        tcp_socket.close();
    }
}

var tcpsocket = class tcpsocket extends ExtensionAPI {
    getAPI(context) {
        context.callOnClose(closeSocket);
        return {
            experiments: {
                tcpsocket: {
                    /** 
                     * Send a DNS query stored in buf over a TCP socket to a 
                     * nameserver addressed by addr
                     */
                    async sendDNSQuery(addr, buf) {
                        let tcp_event_queue;
                        let nextEvent;
                        let answer = new Uint8Array();

                        // Open the TCP socket
                        try {
                            tcp_socket = new TCPSocket(addr, 53, { binaryType: "arraybuffer" });
                        } catch(e) {
                            throw new ExtensionError(e.message);
                        }

                        // Wait for the next event
                        try {
                            tcp_event_queue = listenForEventsOnSocket(tcp_socket, "client");
                            nextEvent = (await tcp_event_queue.waitForEvent()).type;
                        } catch(e) {
                            tcp_socket.close();
                            throw new ExtensionError(e.message);
                        }
                       
                        // If the next event isn't 'open', close the socket and return
                        if (nextEvent == "open" && tcp_socket.readyState == "open") {
                            console.log("client opened socket and readyState is open");
                        } else {
                            tcp_socket.close();
                            throw new ExtensionError("Didn't get open event for TCP socket");
                        }

                        // Send the query, wait for an answer, and then close the socket
                        try {
                            tcp_socket.send(buf.buffer, buf.byteOffset, buf.byteLength);
                            answer = await tcp_event_queue.waitForDataWithAtLeastLength(buf.byteLength);
                        } catch(e) {
                            if (e.message != "only one wait allowed at a time.") {
                                throw new ExtensionError("Error while sending TCP query");
                            }
                        } finally {
                            tcp_socket.close();
                        }
                        return answer;
                    }
                },
            },
        };
    }
};

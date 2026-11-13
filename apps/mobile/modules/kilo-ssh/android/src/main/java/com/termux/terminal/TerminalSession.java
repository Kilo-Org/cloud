package com.termux.terminal;

import java.nio.charset.StandardCharsets;
import java.util.UUID;

/**
 * A terminal screen that exchanges bytes with a {@link TerminalTransport} instead of a local pty.
 * <p>
 * All terminal emulation and callback methods must be performed on the main thread. Output has to be
 * fed with {@link #appendOutput(byte[], int, int)} on the main thread as well.
 */
public final class TerminalSession extends TerminalOutput {

    public final String mHandle = UUID.randomUUID().toString();

    TerminalEmulator mEmulator;

    /** Buffer to write translate code points into utf8 before writing to the transport */
    private final byte[] mUtf8InputBuffer = new byte[5];

    /** Callback which gets notified when a session finishes or changes title. */
    TerminalSessionClient mClient;

    /** Set by the application for user identification of session, not by terminal. */
    public String mSessionName;

    private final Integer mTranscriptRows;
    private final TerminalTransport mTransport;

    private boolean mClosed;
    private int mExitStatus;

    private static final String LOG_TAG = "TerminalSession";

    public TerminalSession(TerminalTransport transport, TerminalSessionClient client, Integer transcriptRows) {
        mTransport = transport;
        mClient = client;
        mTranscriptRows = transcriptRows;
    }

    /**
     * @param client The {@link TerminalSessionClient} interface implementation to allow
     *               for communication between {@link TerminalSession} and its client.
     */
    public void updateTerminalSessionClient(TerminalSessionClient client) {
        mClient = client;

        if (mEmulator != null)
            mEmulator.updateTerminalSessionClient(client);
    }

    /** Inform the transport of the new size and reflow or initialize the emulator. */
    public void updateSize(int columns, int rows) {
        if (mEmulator == null) {
            initializeEmulator(columns, rows);
        } else {
            mTransport.resize(columns, rows);
            mEmulator.resize(columns, rows);
        }
    }

    /** The terminal title as set through escape sequences or null if none set. */
    public String getTitle() {
        return (mEmulator == null) ? null : mEmulator.getTitle();
    }

    /**
     * Set the terminal emulator's window size.
     *
     * @param columns The number of columns in the terminal window.
     * @param rows    The number of rows in the terminal window.
     */
    public void initializeEmulator(int columns, int rows) {
        mEmulator = new TerminalEmulator(this, columns, rows, mTranscriptRows, mClient);
        mTransport.resize(columns, rows);
    }

    /** Write data to the other end of the transport. */
    @Override
    public void write(byte[] data, int offset, int count) {
        mTransport.write(data, offset, count);
    }

    /** Write the Unicode code point to the terminal encoded in UTF-8. */
    public void writeCodePoint(boolean prependEscape, int codePoint) {
        if (codePoint > 1114111 || (codePoint >= 0xD800 && codePoint <= 0xDFFF)) {
            throw new IllegalArgumentException("Invalid code point: " + codePoint);
        }

        int bufferPosition = 0;
        if (prependEscape) mUtf8InputBuffer[bufferPosition++] = 27;

        if (codePoint <= /* 7 bits */0b1111111) {
            mUtf8InputBuffer[bufferPosition++] = (byte) codePoint;
        } else if (codePoint <= /* 11 bits */0b11111111111) {
            mUtf8InputBuffer[bufferPosition++] = (byte) (0b11000000 | (codePoint >> 6));
            mUtf8InputBuffer[bufferPosition++] = (byte) (0b10000000 | (codePoint & 0b111111));
        } else if (codePoint <= /* 16 bits */0b1111111111111111) {
            mUtf8InputBuffer[bufferPosition++] = (byte) (0b11100000 | (codePoint >> 12));
            mUtf8InputBuffer[bufferPosition++] = (byte) (0b10000000 | ((codePoint >> 6) & 0b111111));
            mUtf8InputBuffer[bufferPosition++] = (byte) (0b10000000 | (codePoint & 0b111111));
        } else {
            mUtf8InputBuffer[bufferPosition++] = (byte) (0b11110000 | (codePoint >> 18));
            mUtf8InputBuffer[bufferPosition++] = (byte) (0b10000000 | ((codePoint >> 12) & 0b111111));
            mUtf8InputBuffer[bufferPosition++] = (byte) (0b10000000 | ((codePoint >> 6) & 0b111111));
            mUtf8InputBuffer[bufferPosition++] = (byte) (0b10000000 | (codePoint & 0b111111));
        }
        write(mUtf8InputBuffer, 0, bufferPosition);
    }

    public TerminalEmulator getEmulator() {
        return mEmulator;
    }

    /** Notify the {@link #mClient} that the screen has changed. */
    protected void notifyScreenUpdate() {
        mClient.onTextChanged(this);
    }

    /** Feed bytes received from the transport into the emulator. Must be called on the main thread. */
    public void appendOutput(byte[] data, int offset, int count) {
        if (mEmulator == null) return;
        if (offset == 0 && count == data.length) {
            mEmulator.append(data, count);
        } else {
            byte[] slice = new byte[count];
            System.arraycopy(data, offset, slice, 0, count);
            mEmulator.append(slice, count);
        }
        notifyScreenUpdate();
    }

    /** Reset state for terminal emulator state. */
    public void reset() {
        mEmulator.reset();
        notifyScreenUpdate();
    }

    /** Finish this terminal session by closing the transport. */
    public void finishIfRunning() {
        if (isRunning()) mTransport.close();
    }

    /** Report that the transport closed. Must be called on the main thread. */
    public void notifyTransportClosed(int exitStatus, String error) {
        mClosed = true;
        mExitStatus = exitStatus;

        StringBuilder description = new StringBuilder("\r\n[Connection closed");
        if (error != null) {
            description.append(": ").append(error);
        } else if (exitStatus != 0) {
            description.append(" (code ").append(exitStatus).append(')');
        }
        description.append(']');

        byte[] bytesToWrite = description.toString().getBytes(StandardCharsets.UTF_8);
        mEmulator.append(bytesToWrite, bytesToWrite.length);
        notifyScreenUpdate();

        mClient.onSessionFinished(this);
    }

    public synchronized boolean isRunning() {
        return !mClosed;
    }

    /** Only valid if not {@link #isRunning()}. */
    public synchronized int getExitStatus() {
        return mExitStatus;
    }

    @Override
    public void titleChanged(String oldTitle, String newTitle) {
        mClient.onTitleChanged(this);
    }

    @Override
    public void onCopyTextToClipboard(String text) {
        mClient.onCopyTextToClipboard(this, text);
    }

    @Override
    public void onPasteTextFromClipboard() {
        mClient.onPasteTextFromClipboard(this);
    }

    @Override
    public void onBell() {
        mClient.onBell(this);
    }

    @Override
    public void onColorsChanged() {
        mClient.onColorsChanged(this);
    }

}

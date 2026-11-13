package com.termux.terminal;

/** Carries the bytes exchanged between a {@link TerminalSession} and whatever is attached to its other end. */
public interface TerminalTransport {

    void write(byte[] data, int offset, int count);

    void resize(int columns, int rows);

    void close();

}

import { describe, expect, test } from '@jest/globals';
import { isEmailOnBlockedTld } from './domain-gates';

describe('isEmailOnBlockedTld', () => {
  const defaultTlds = ['shop', 'top'];

  test('should block the default .shop and .top TLDs', () => {
    expect(isEmailOnBlockedTld('user@example.shop', defaultTlds)).toBe(true);
    expect(isEmailOnBlockedTld('user@example.top', defaultTlds)).toBe(true);
  });

  test('should block a TLD added by an admin', () => {
    expect(isEmailOnBlockedTld('user@example.asia', defaultTlds)).toBe(false);
    expect(isEmailOnBlockedTld('user@example.asia', [...defaultTlds, 'asia'])).toBe(true);
  });

  test('should block subdomains under blocked TLDs', () => {
    expect(isEmailOnBlockedTld('user@sub.domain.shop', defaultTlds)).toBe(true);
    expect(isEmailOnBlockedTld('user@sub.domain.top', defaultTlds)).toBe(true);
    expect(isEmailOnBlockedTld('user@sub.domain.asia', ['asia'])).toBe(true);
  });

  test('should allow .com, .org, .io TLDs', () => {
    expect(isEmailOnBlockedTld('user@example.com', defaultTlds)).toBe(false);
    expect(isEmailOnBlockedTld('user@example.org', defaultTlds)).toBe(false);
    expect(isEmailOnBlockedTld('user@example.io', defaultTlds)).toBe(false);
  });

  test('should be case insensitive', () => {
    expect(isEmailOnBlockedTld('user@example.SHOP', defaultTlds)).toBe(true);
    expect(isEmailOnBlockedTld('user@example.TOP', defaultTlds)).toBe(true);
    expect(isEmailOnBlockedTld('user@example.ASIA', ['asia'])).toBe(true);
    expect(isEmailOnBlockedTld('USER@EXAMPLE.Shop', defaultTlds)).toBe(true);
  });

  test('should not block domains containing blocked TLD as a non-TLD part', () => {
    expect(isEmailOnBlockedTld('user@shop.example.com', defaultTlds)).toBe(false);
    expect(isEmailOnBlockedTld('user@top.example.com', defaultTlds)).toBe(false);
    expect(isEmailOnBlockedTld('user@myshop.com', defaultTlds)).toBe(false);
    expect(isEmailOnBlockedTld('user@topnotch.com', defaultTlds)).toBe(false);
    expect(isEmailOnBlockedTld('user@example.shop.com', defaultTlds)).toBe(false);
    expect(isEmailOnBlockedTld('user@example.top.com', defaultTlds)).toBe(false);
    expect(isEmailOnBlockedTld('user@example.asia.com', ['asia'])).toBe(false);
    expect(isEmailOnBlockedTld('user@asia.example.com', ['asia'])).toBe(false);
    expect(isEmailOnBlockedTld('user@notasia.com', ['asia'])).toBe(false);
  });

  test('should require a leading dot before the blocked TLD', () => {
    expect(isEmailOnBlockedTld('user@exampleshop', defaultTlds)).toBe(false);
    expect(isEmailOnBlockedTld('user@exampletop', defaultTlds)).toBe(false);
    expect(isEmailOnBlockedTld('user@exampleasia', ['asia'])).toBe(false);
  });

  test('should allow every TLD when the admin list is empty', () => {
    expect(isEmailOnBlockedTld('user@example.shop', [])).toBe(false);
    expect(isEmailOnBlockedTld('user@example.asia', [])).toBe(false);
  });

  test('should allow other TLDs including multi-part TLDs', () => {
    expect(isEmailOnBlockedTld('user@example.co.uk', defaultTlds)).toBe(false);
    expect(isEmailOnBlockedTld('user@example.uk', defaultTlds)).toBe(false);
  });
});

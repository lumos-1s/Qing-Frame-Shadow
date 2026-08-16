package com.qingframe.server.util;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;

class JwtUtilTest {

    private static final String SECRET = "test-secret-key-with-more-than-32-bytes-for-hs256!!";

    private JwtUtil newUtil() {
        return new JwtUtil(SECRET, 24);
    }

    @Test
    void createAndParseTokenReturnsUserId() {
        JwtUtil jwt = newUtil();
        String token = jwt.createToken(42L);
        assertNotNull(token);
        assertEquals(42L, jwt.parseUserId(token));
    }

    @Test
    void expiredTokenThrows() {
        JwtUtil jwt = new JwtUtil(SECRET, 0); // 立即过期
        String token = jwt.createToken(1L);
        assertThrows(Exception.class, () -> jwt.parseUserId(token));
    }

    @Test
    void tamperedTokenThrows() {
        JwtUtil jwt = newUtil();
        String token = jwt.createToken(7L);
        String tampered = token.substring(0, token.length() - 2) + "xx";
        assertThrows(Exception.class, () -> jwt.parseUserId(tampered));
    }

    @Test
    void expireSecondsReflectsConfiguredHours() {
        assertEquals(24 * 3600, newUtil().getExpireSeconds());
    }
}

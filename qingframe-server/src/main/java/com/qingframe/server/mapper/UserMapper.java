package com.qingframe.server.mapper;

import com.qingframe.server.entity.User;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;

@Mapper
public interface UserMapper {

    User findByUsername(@Param("username") String username);

    User findByEmail(@Param("email") String email);

    User findById(@Param("id") Long id);

    int insert(User user);

    /** 更新个人资料（昵称 + 头像 + 邮箱），仅更新非 null 字段 */
    int updateProfile(@Param("id") Long id,
                      @Param("nickname") String nickname,
                      @Param("avatar") String avatar,
                      @Param("email") String email);

    /** 更新密码（BCrypt 哈希） */
    int updatePassword(@Param("id") Long id,
                       @Param("passwordHash") String passwordHash);
}

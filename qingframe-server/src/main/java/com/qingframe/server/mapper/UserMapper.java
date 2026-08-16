package com.qingframe.server.mapper;

import com.qingframe.server.entity.User;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;

@Mapper
public interface UserMapper {

    User findByUsername(@Param("username") String username);

    User findById(@Param("id") Long id);

    int insert(User user);

    /** 更新个人资料（昵称 + 头像），仅更新非 null 字段 */
    int updateProfile(@Param("id") Long id,
                      @Param("nickname") String nickname,
                      @Param("avatar") String avatar);
}

package com.qingframe.server.mapper;

import com.qingframe.server.entity.Preset;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;

import java.util.List;

@Mapper
public interface PresetMapper {

    List<Preset> findPage(@Param("tag") String tag,
                          @Param("keyword") String keyword,
                          @Param("offset") int offset,
                          @Param("size") int size);

    long countPage(@Param("tag") String tag,
                   @Param("keyword") String keyword);

    Preset findById(@Param("id") Long id);

    int insert(Preset preset);

    int update(Preset preset);

    int delete(@Param("id") Long id);

    int incDownloadCount(@Param("id") Long id);

    int insertDownloadLog(@Param("presetId") Long presetId,
                          @Param("userId") Long userId,
                          @Param("ip") String ip);

    List<String> findTags();

    int insertLike(@Param("presetId") Long presetId, @Param("userId") Long userId);

    int deleteLike(@Param("presetId") Long presetId, @Param("userId") Long userId);

    int countLike(@Param("presetId") Long presetId, @Param("userId") Long userId);

    int incLikeCount(@Param("id") Long id);

    int decLikeCount(@Param("id") Long id);
}

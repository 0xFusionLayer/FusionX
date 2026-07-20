// SPDX-License-Identifier: UNLICENSED

/*
 * Copyright © 2026 Originally copyrighted by
 * 0x560eA05cc475396Cb3D957D55b5dA3E54d819a1e (FusionX Project).
 * All rights reserved.
 *
 * This source code is the proprietary intellectual property of
 * the above copyright holder and the FusionX Project.
 * It is published solely for transparency and verifiability and is not open source.
 *
 * Any unauthorized copying, cloning, reproduction, modification, distribution,
 * or commercial exploitation — in whole or in part — is strictly prohibited
 * without prior written permission.
 */

pragma solidity ^0.8.0;

contract FusionX {
    enum Reaction { NONE, LIKE, DISLIKE }

    struct UserBasic {
        uint256 userId;
        string username;
        uint256 accountCreationTime;
        uint256 accountCreationBlock;
        bool isRegistered;
    }

    struct UserProfile {
        string nickname;
        string about;
        string website;
        string location;
        string profilePicture;
        string coverPicture;
        uint256 pinnedPost;
    }

    struct UserStats {
        uint256 postCount;
        uint256 commentCount;
        uint256 followerCount;
        uint256 followingCount;
    }

    struct Post {
        uint256 globalPostId;
        address author;
        uint256 authorPostId;
        uint256 postTime;
        string content;
        uint256 commentCount;
        uint256 likeCount;
        uint256 dislikeCount;
        uint256 repostCount;
        bool isHidden;
        bool isRepost;
        uint256 originalPostId;
        string reposterContent;
        mapping(address => Reaction) reactions;
    }

    struct Comment {
        uint256 commentId;
        address author;
        uint256 commentTime;
        string comment;
        uint256 likeCount;
        uint256 dislikeCount;
        bool isHidden;
        mapping(address => Reaction) reactions;
    }

    struct UserComment {
        uint256 globalPostId;
        uint256 commentId;
    }

    uint256 private totalUsers;
    uint256 private globalPostCount;

    mapping(string => address) private usernameToAddress;
    mapping(uint256 => address) private userAddressById;

    mapping(address => UserBasic) private userBasics;
    mapping(address => UserProfile) private userProfiles;
    mapping(address => UserStats) private userStats;

    mapping(uint256 => Post) private allPosts;

    mapping(address => mapping(uint256 => uint256)) private userPostId;

    mapping(uint256 => mapping(uint256 => Comment)) private postComments;
    mapping(uint256 => uint256) private postCommentCount;

    mapping(address => mapping(uint256 => UserComment)) private userComments;
    mapping(address => uint256) private userCommentCount;

    mapping(uint256 => mapping(address => bool)) private hasCommentedOnPost;
    mapping(uint256 => mapping(address => bool)) private hasRepostedOnPost;

    mapping(address => mapping(address => bool)) private isFollowing;

    modifier onlyEOA() {
        require(msg.sender.code.length == 0, "Contracts not allowed");
        _;
    }

    function _toLower(string memory str) internal pure returns (string memory) {
        bytes memory bStr = bytes(str);
        for (uint i = 0; i < bStr.length; i++) {
            if (bStr[i] >= 0x41 && bStr[i] <= 0x5A) {
                bStr[i] = bytes1(uint8(bStr[i]) + 32);
            }
        }
        return string(bStr);
    }

    function _validLowercaseUsername(string memory _usernameLower) internal pure returns (bool) {
        bytes memory b = bytes(_usernameLower);
        if (b.length < 5) return false;
        for (uint256 i = 0; i < b.length; i++) {
            bytes1 char = b[i];
            bool isLowerLetter = (char >= 0x61 && char <= 0x7A);
            bool isDigit = (char >= 0x30 && char <= 0x39);
            if (!isLowerLetter && !isDigit) {
                return false;
            }
        }
        return true;
    }

    function _stringToReaction(string memory reactionStr) internal pure returns (Reaction) {
        bytes32 hashVal = keccak256(abi.encodePacked(reactionStr));
        if (hashVal == keccak256(abi.encodePacked("like"))) {
            return Reaction.LIKE;
        } else if (hashVal == keccak256(abi.encodePacked("dislike"))) {
            return Reaction.DISLIKE;
        } else {
            return Reaction.NONE;
        }
    }

    function createAccount(string memory _nickname, string memory _username) external onlyEOA {
        require(!userBasics[msg.sender].isRegistered, "Already registered");
        require(bytes(_nickname).length > 0, "Nickname is required");
        require(bytes(_username).length > 0, "Username is required");
        string memory usernameLower = _toLower(_username);
        require(_validLowercaseUsername(usernameLower), "Invalid username format");
        require(usernameToAddress[usernameLower] == address(0), "Username already taken");
        totalUsers++;
        userAddressById[totalUsers] = msg.sender;
        userBasics[msg.sender] = UserBasic({
            userId: totalUsers,
            username: _username,
            accountCreationTime: block.timestamp,
            accountCreationBlock: block.number,
            isRegistered: true
        });
        userProfiles[msg.sender] = UserProfile({
            nickname: _nickname,
            about: "",
            website: "",
            location: "",
            profilePicture: "",
            coverPicture: "",
            pinnedPost: 0
        });
        userStats[msg.sender] = UserStats({
            postCount: 0,
            commentCount: 0,
            followerCount: 0,
            followingCount: 0
        });
        usernameToAddress[usernameLower] = msg.sender;
    }

    function changeUsername(string memory _newUsername) external onlyEOA {
        require(userBasics[msg.sender].isRegistered, "User not registered");
        string memory oldUsernameLower = _toLower(userBasics[msg.sender].username);
        usernameToAddress[oldUsernameLower] = address(0);
        string memory newUsernameLower = _toLower(_newUsername);
        require(_validLowercaseUsername(newUsernameLower), "Invalid username format");
        require(usernameToAddress[newUsernameLower] == address(0), "Username already taken");
        userBasics[msg.sender].username = _newUsername;
        usernameToAddress[newUsernameLower] = msg.sender;
    }

    function updateNickname(string memory _nickname) external onlyEOA {
        require(userBasics[msg.sender].isRegistered, "User not registered");
        require(bytes(_nickname).length > 0, "Nickname cannot be empty");
        userProfiles[msg.sender].nickname = _nickname;
    }

    function updateAbout(string memory _about) external onlyEOA {
        require(userBasics[msg.sender].isRegistered, "User not registered");
        userProfiles[msg.sender].about = _about;
    }

    function updateWebsite(string memory _website) external onlyEOA {
        require(userBasics[msg.sender].isRegistered, "User not registered");
        userProfiles[msg.sender].website = _website;
    }

    function updateLocation(string memory _location) external onlyEOA {
        require(userBasics[msg.sender].isRegistered, "User not registered");
        userProfiles[msg.sender].location = _location;
    }

    function updateProfilePicture(string memory _profilePicture) external onlyEOA {
        require(userBasics[msg.sender].isRegistered, "User not registered");
        userProfiles[msg.sender].profilePicture = _profilePicture;
    }

    function updateCoverPicture(string memory _coverPicture) external onlyEOA {
        require(userBasics[msg.sender].isRegistered, "User not registered");
        userProfiles[msg.sender].coverPicture = _coverPicture;
    }

    function createPost(string memory _content) external onlyEOA {
        require(userBasics[msg.sender].isRegistered, "User not registered");
        require(bytes(_content).length > 0, "Post content cannot be empty");
        UserStats storage stats = userStats[msg.sender];
        globalPostCount++;
        stats.postCount++;
        Post storage p = allPosts[globalPostCount];
        p.globalPostId = globalPostCount;
        p.author = msg.sender;
        p.authorPostId = stats.postCount;
        p.postTime = block.timestamp;
        p.content = _content;
        p.commentCount = 0;
        p.likeCount = 0;
        p.dislikeCount = 0;
        p.repostCount = 0;
        p.isHidden = false;
        p.isRepost = false;
        p.originalPostId = 0;
        p.reposterContent = "";
        userPostId[msg.sender][stats.postCount] = globalPostCount;
    }

    function createRepost(uint256 _globalPostId, string memory _reposterContent) external onlyEOA {
        require(userBasics[msg.sender].isRegistered, "User not registered");
        require(_globalPostId > 0 && _globalPostId <= globalPostCount, "Invalid Post ID");
        Post storage originalPost = allPosts[_globalPostId];
        originalPost.repostCount++;
        UserStats storage stats = userStats[msg.sender];
        stats.postCount++;
        globalPostCount++;
        Post storage newPost = allPosts[globalPostCount];
        newPost.globalPostId = globalPostCount;
        newPost.author = msg.sender;
        newPost.authorPostId = stats.postCount;
        newPost.postTime = block.timestamp;
        newPost.content = "";
        newPost.commentCount = 0;
        newPost.likeCount = 0;
        newPost.dislikeCount = 0;
        newPost.repostCount = 0;
        newPost.isHidden = false;
        newPost.isRepost = true;
        newPost.originalPostId = _globalPostId;
        newPost.reposterContent = _reposterContent;
        userPostId[msg.sender][stats.postCount] = globalPostCount;
        hasRepostedOnPost[_globalPostId][msg.sender] = true;
    }

    function hidePost(uint256 _globalPostId, bool _hidden) external onlyEOA {
        require(_globalPostId > 0 && _globalPostId <= globalPostCount, "Invalid post id");
        Post storage p = allPosts[_globalPostId];
        require(p.author == msg.sender, "Not authorized to hide this post");
        p.isHidden = _hidden;
    }

    function editPost(uint256 _globalPostId, string memory _newContent) external onlyEOA {
        require(_globalPostId > 0 && _globalPostId <= globalPostCount, "Invalid post id");
        require(bytes(_newContent).length > 0, "Post content cannot be empty");
        Post storage p = allPosts[_globalPostId];
        require(p.author == msg.sender, "Not authorized to edit this post");
        require(!p.isRepost, "This is a repost. Use editRepost instead.");
        p.content = _newContent;
    }

    function editRepost(uint256 _globalPostId, string memory _newReposterContent) external onlyEOA {
        require(_globalPostId > 0 && _globalPostId <= globalPostCount, "Invalid post id");
        Post storage p = allPosts[_globalPostId];
        require(p.author == msg.sender, "Not authorized to edit this repost");
        require(p.isRepost, "This is not a repost");
        p.reposterContent = _newReposterContent;
    }

    function pinPost(uint256 _globalPostId) external onlyEOA {
        require(userBasics[msg.sender].isRegistered, "User not registered");
        if (_globalPostId != 0) {
            require(_globalPostId > 0 && _globalPostId <= globalPostCount, "Invalid post id");
            Post storage p = allPosts[_globalPostId];
            require(p.author == msg.sender, "Cannot pin a post that is not yours");
        }
        userProfiles[msg.sender].pinnedPost = _globalPostId;
    }

    function createComment(uint256 _globalPostId, string memory _comment) external onlyEOA {
        require(userBasics[msg.sender].isRegistered, "User not registered");
        require(_globalPostId > 0 && _globalPostId <= globalPostCount, "Invalid Post ID");
        require(bytes(_comment).length > 0, "Comment cannot be empty");
        Post storage p = allPosts[_globalPostId];
        p.commentCount++;
        userStats[msg.sender].commentCount++;
        uint256 cId = p.commentCount;
        Comment storage c = postComments[_globalPostId][cId];
        c.commentId = cId;
        c.author = msg.sender;
        c.commentTime = block.timestamp;
        c.comment = _comment;
        c.likeCount = 0;
        c.dislikeCount = 0;
        c.isHidden = false;
        postCommentCount[_globalPostId] = p.commentCount;
        hasCommentedOnPost[_globalPostId][msg.sender] = true;
        userCommentCount[msg.sender]++;
        uint256 userCommentId = userCommentCount[msg.sender];
        userComments[msg.sender][userCommentId] = UserComment({
            globalPostId: _globalPostId,
            commentId: cId
        });
    }

    function editComment(uint256 _globalPostId, uint256 _commentId, string memory _newComment) external onlyEOA {
        require(_globalPostId > 0 && _globalPostId <= globalPostCount, "Invalid Post ID");
        require(_commentId > 0 && _commentId <= postCommentCount[_globalPostId], "Invalid Comment ID");
        require(bytes(_newComment).length > 0, "Comment cannot be empty");
        Comment storage c = postComments[_globalPostId][_commentId];
        require(c.author == msg.sender, "Not authorized to edit this comment");
        c.comment = _newComment;
    }

    function hideComment(uint256 _globalPostId, uint256 _commentId, bool _hidden) external onlyEOA {
        require(_globalPostId > 0 && _globalPostId <= globalPostCount, "Invalid Post ID");
        require(_commentId > 0 && _commentId <= postCommentCount[_globalPostId], "Invalid Comment ID");
        Comment storage c = postComments[_globalPostId][_commentId];
        require(c.author == msg.sender, "Not authorized to hide this comment");
        c.isHidden = _hidden;
    }

    function reactToPost(uint256 _globalPostId, string memory _reactionStr) external onlyEOA {
        require(userBasics[msg.sender].isRegistered, "User not registered");
        require(_globalPostId > 0 && _globalPostId <= globalPostCount, "Invalid Post ID");
        Post storage p = allPosts[_globalPostId];
        Reaction oldReaction = p.reactions[msg.sender];
        Reaction newReaction = _stringToReaction(_reactionStr);
        if (oldReaction == newReaction) {
            return;
        }
        if (oldReaction == Reaction.LIKE && p.likeCount > 0) {
            p.likeCount--;
        } else if (oldReaction == Reaction.DISLIKE && p.dislikeCount > 0) {
            p.dislikeCount--;
        }
        if (newReaction == Reaction.LIKE) {
            p.likeCount++;
        } else if (newReaction == Reaction.DISLIKE) {
            p.dislikeCount++;
        }
        p.reactions[msg.sender] = newReaction;
    }

    function reactToComment(uint256 _globalPostId, uint256 _commentId, string memory _reactionStr) external onlyEOA {
        require(userBasics[msg.sender].isRegistered, "User not registered");
        require(_globalPostId > 0 && _globalPostId <= globalPostCount, "Invalid Post ID");
        require(_commentId > 0 && _commentId <= postCommentCount[_globalPostId], "Invalid Comment ID");
        Comment storage c = postComments[_globalPostId][_commentId];
        Reaction oldReaction = c.reactions[msg.sender];
        Reaction newReaction = _stringToReaction(_reactionStr);
        if (oldReaction == newReaction) {
            return;
        }
        if (oldReaction == Reaction.LIKE && c.likeCount > 0) {
            c.likeCount--;
        } else if (oldReaction == Reaction.DISLIKE && c.dislikeCount > 0) {
            c.dislikeCount--;
        }
        if (newReaction == Reaction.LIKE) {
            c.likeCount++;
        } else if (newReaction == Reaction.DISLIKE) {
            c.dislikeCount++;
        }
        c.reactions[msg.sender] = newReaction;
    }

    function followUser(address _userToFollow, bool _follow) external onlyEOA {
        require(userBasics[msg.sender].isRegistered, "Caller not registered");
        require(userBasics[_userToFollow].isRegistered, "Target not registered");
        require(_userToFollow != msg.sender, "Cannot follow yourself");
        if (_follow) {
            if (!isFollowing[msg.sender][_userToFollow]) {
                isFollowing[msg.sender][_userToFollow] = true;
                userStats[_userToFollow].followerCount += 1;
                userStats[msg.sender].followingCount += 1;
            }
        } else {
            if (isFollowing[msg.sender][_userToFollow]) {
                isFollowing[msg.sender][_userToFollow] = false;
                if (userStats[_userToFollow].followerCount > 0) {
                    userStats[_userToFollow].followerCount -= 1;
                }
                if (userStats[msg.sender].followingCount > 0) {
                    userStats[msg.sender].followingCount -= 1;
                }
            }
        }
    }

    function getTotalUsers() external view returns (uint256) {
        return totalUsers;
    }

    function getGlobalPostCount() external view returns (uint256) {
        return globalPostCount;
    }

    function getUserAddressById(uint256 _userId) external view returns (address) {
        require(_userId > 0 && _userId <= totalUsers, "Invalid user id");
        return userAddressById[_userId];
    }

    function getUserAddressByUsername(string memory _username) external view returns (address) {
        string memory usernameLower = _toLower(_username);
        return usernameToAddress[usernameLower];
    }

    function getUserBasic(address _user) external view returns (uint256, string memory, uint256, uint256, bool) {
        require(userBasics[_user].isRegistered, "User not registered");
        UserBasic storage ub = userBasics[_user];
        return (ub.userId, ub.username, ub.accountCreationTime, ub.accountCreationBlock, ub.isRegistered);
    }

    function getUserProfile(address _user)
        external
        view
        returns (
            string memory,
            string memory,
            string memory,
            string memory,
            string memory,
            string memory,
            uint256
        )
    {
        require(userBasics[_user].isRegistered, "User not registered");
        UserProfile storage up = userProfiles[_user];
        return (
            up.nickname,
            up.about,
            up.website,
            up.location,
            up.profilePicture,
            up.coverPicture,
            up.pinnedPost
        );
    }

    function getUserStats(address _user)
        external
        view
        returns (
            uint256,
            uint256,
            uint256,
            uint256
        )
    {
        require(userBasics[_user].isRegistered, "User not registered");
        UserStats storage us = userStats[_user];
        return (us.postCount, us.commentCount, us.followerCount, us.followingCount);
    }

    function getGlobalPostId(address _user, uint256 _userPostId) external view returns (uint256) {
        return userPostId[_user][_userPostId];
    }

    function getPost(uint256 _globalPostId)
        external
        view
        returns (
            uint256,
            address,
            uint256,
            uint256,
            string memory,
            uint256,
            uint256,
            uint256,
            bool,
            bool,
            uint256,
            uint256
        )
    {
        require(_globalPostId > 0 && _globalPostId <= globalPostCount, "Invalid Post ID");
        Post storage p = allPosts[_globalPostId];
        string memory postText = p.isHidden ? "" : (p.isRepost ? p.reposterContent : p.content);
        return (
            p.globalPostId,
            p.author,
            p.authorPostId,
            p.postTime,
            postText,
            p.commentCount,
            p.likeCount,
            p.dislikeCount,
            p.isHidden,
            p.isRepost,
            p.originalPostId,
            p.repostCount
        );
    }

    function getPostCommentCount(uint256 _globalPostId) external view returns (uint256) {
        require(_globalPostId > 0 && _globalPostId <= globalPostCount, "Invalid Post ID");
        return postCommentCount[_globalPostId];
    }

    function getUserCommentCount(address _user) external view returns (uint256) {
        return userCommentCount[_user];
    }

    function getHasCommentedOnPost(uint256 _globalPostId, address _user) external view returns (bool) {
        require(_globalPostId > 0 && _globalPostId <= globalPostCount, "Invalid Post ID");
        return hasCommentedOnPost[_globalPostId][_user];
    }

    function getHasRepostedAPost(uint256 _globalPostId, address _user) external view returns (bool) {
        require(_globalPostId > 0 && _globalPostId <= globalPostCount, "Invalid Post ID");
        return hasRepostedOnPost[_globalPostId][_user];
    }

    function getComment(uint256 _globalPostId, uint256 _commentId)
        external
        view
        returns (
            uint256,
            uint256,
            address,
            uint256,
            string memory,
            uint256,
            uint256,
            bool
        )
    {
        require(_globalPostId > 0 && _globalPostId <= globalPostCount, "Invalid Post ID");
        require(_commentId > 0 && _commentId <= postCommentCount[_globalPostId], "Invalid Comment ID");
        Comment storage c = postComments[_globalPostId][_commentId];
        string memory commentText = c.isHidden ? "" : c.comment;
        return (
            _globalPostId,
            c.commentId,
            c.author,
            c.commentTime,
            commentText,
            c.likeCount,
            c.dislikeCount,
            c.isHidden
        );
    }

    function getUserComment(address _user, uint256 _userCommentId)
        external
        view
        returns (uint256, uint256)
    {
        require(userBasics[_user].isRegistered, "User not registered");
        require(_userCommentId > 0 && _userCommentId <= userCommentCount[_user], "Invalid user Comment ID");
        UserComment storage uc = userComments[_user][_userCommentId];
        return (uc.globalPostId, uc.commentId);
    }

    function getUserReactionOnPost(uint256 _globalPostId, address _user) external view returns (string memory) {
        require(_globalPostId > 0 && _globalPostId <= globalPostCount, "Invalid Post ID");
        Reaction r = allPosts[_globalPostId].reactions[_user];
        if (r == Reaction.LIKE) return "like";
        if (r == Reaction.DISLIKE) return "dislike";
        return "0";
    }

    function getUserReactionOnComment(uint256 _globalPostId, uint256 _commentId, address _user) external view returns (string memory) {
        require(_globalPostId > 0 && _globalPostId <= globalPostCount, "Invalid Post ID");
        require(_commentId > 0 && _commentId <= postCommentCount[_globalPostId], "Invalid Comment ID");
        Reaction r = postComments[_globalPostId][_commentId].reactions[_user];
        if (r == Reaction.LIKE) return "like";
        if (r == Reaction.DISLIKE) return "dislike";
        return "0";
    }

    function getIsFollowing(address _follower, address _followed) external view returns (bool) {
        return isFollowing[_follower][_followed];
    }

    function isUserRegistered(address _user) external view returns (bool) {
        return userBasics[_user].isRegistered;
    }
}